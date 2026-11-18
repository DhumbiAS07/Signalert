import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { collection, addDoc } from 'firebase/firestore';
import { db } from './src/firebase.js'; // note: extension is needed if ESM but we can import from ./src/firebase in our ts file

// Ensure environment variables are loaded
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Increase payload size limit to accept base64 image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize Google Gen AI client with appropriate headers
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Endpoint to process reporting sign damage
app.post('/api/reports', async (req, res) => {
  try {
    const { image, latitude, longitude, userId, userName, userEmail } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'Image is required for sign damage reporting.' });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Location coordinates (latitude and longitude) are required.' });
    }

    // Extract mimeType and raw base64 data
    const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    let mimeType = 'image/jpeg';
    let base64Data = image;

    if (matches && matches.length === 3) {
      mimeType = matches[1];
      base64Data = matches[2];
    }

    // Define the structured JSON response schema from Gemini API
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        isRoadSign: {
          type: Type.BOOLEAN,
          description: "True if the image contains a road sign, false otherwise."
        },
        signType: {
          type: Type.STRING,
          description: "Identify the type of road sign (e.g., Stop Sign, Yield, Speed Limit 35, One Way, Warning, etc.). Empty string if not a road sign."
        },
        damageDescription: {
          type: Type.STRING,
          description: "Describe any visible damage or issues with the road sign (e.g., graffiti, bullet holes, bent post, rusting, fading, peeling paint). Empty string if not a road sign."
        },
        severityScore: {
          type: Type.INTEGER,
          description: "Rate the severity of the damage on a scale of 1 to 5. 1 represents minimal/purely cosmetic damage, and 5 represents severe damage that makes the sign unreadable or presents a physical hazard."
        },
        error: {
          type: Type.STRING,
          description: "A friendly error message if the image does not contain any road sign. Empty or null otherwise."
        }
      },
      required: ["isRoadSign", "signType", "damageDescription", "severityScore"]
    };

    // Prompt Gemini 2.5 Flash to analyze the image
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType,
            data: base64Data
          }
        },
        {
          text: "Analyze this image. First, verify if it contains a road sign. If it does not, return an error. If it does, identify the type of sign, describe the visible damage, and rate the severity of the damage on a scale of 1 to 5. Return the response strictly as a JSON object."
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        systemInstruction: "You are a professional traffic safety and public infrastructure analysis assistant. Your job is to strictly analyze uploaded road signs and assess their structural and visual damage."
      }
    });

    const aiText = response.text;
    if (!aiText) {
      throw new Error('No response content received from Gemini AI.');
    }

    // Parse the JSON output
    const analysis = JSON.parse(aiText.trim());

    // Validate if it is a road sign
    if (!analysis.isRoadSign) {
      return res.status(422).json({
        error: analysis.error || 'The uploaded image does not contain a recognizable road sign. Please capture a clear image of a road sign.'
      });
    }

    // Document object for Firestore
    const reportData = {
      imageUrl: image, // Store the uploaded base64 data URL
      signType: analysis.signType || 'Unknown Sign',
      damageDescription: analysis.damageDescription || 'No visible damage described.',
      severityScore: Number(analysis.severityScore) || 1,
      latitude: Number(latitude),
      longitude: Number(longitude),
      userId: userId ? String(userId) : null,
      userName: userName ? String(userName) : 'Community Scout',
      userEmail: userEmail ? String(userEmail) : null,
      status: 'Pending / Not Done',
      resolvedBy: null,
      resolvedAt: null,
      timestamp: new Date().toISOString() // Store ISO timestamp for client and rules
    };

    // Save to Firestore 'reports' collection
    const docRef = await addDoc(collection(db, 'reports'), reportData);

    return res.status(201).json({
      id: docRef.id,
      ...reportData
    });

  } catch (error: any) {
    console.error('Server error reporting damage:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to process report.',
      details: error instanceof Error ? error.stack : String(error)
    });
  }
});

// Configure static asset serving or Vite Dev Middleware
if (process.env.NODE_ENV === 'production') {
  // In production, serve the built files
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
} else {
  // In development, mount Vite's Dev Server as middleware
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom'
  });
  app.use(vite.middlewares);
  
  app.use('*', async (req, res, next) => {
    const url = req.originalUrl;
    try {
      let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
      template = await vite.transformIndexHtml(url, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
