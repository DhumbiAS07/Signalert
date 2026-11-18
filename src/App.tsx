import { useState, useEffect, useRef } from 'react';
import {
  Camera,
  MapPin,
  AlertTriangle,
  LayoutDashboard,
  Upload,
  CheckCircle,
  XCircle,
  Compass,
  Clock,
  LogOut,
  Search,
  ShieldAlert,
  RefreshCw,
  Activity,
  Image as ImageIcon,
  ShieldCheck,
  Users,
  ArrowLeftRight,
  CheckSquare,
  Square,
  Map as MapIcon
} from 'lucide-react';
import {
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  deleteDoc,
  updateDoc
} from 'firebase/firestore';
import { db, auth, OperationType, handleFirestoreError } from './firebase';
import { APIProvider, Map, AdvancedMarker, Pin, InfoWindow, useMap } from '@vis.gl/react-google-maps';

type UserRole = 'public' | 'official';
type ReportStatus = 'Pending / Not Done' | 'Work Done';

const ROLE_STORAGE_KEY = 'signalert_selected_role';

const normalizeStatus = (status?: string | null): ReportStatus => {
  return status === 'Work Done' ? 'Work Done' : 'Pending / Not Done';
};

const getRoleFromHash = (): UserRole | null => {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.toLowerCase();
  if (hash === '#official' || hash === '#/official') return 'official';
  if (hash === '#public' || hash === '#/public') return 'public';
  return null;
};

// Color mapper for hazard levels
const getSeverityColor = (score: number) => {
  switch (score) {
    case 5: return '#ef4444'; // Red
    case 4: return '#f97316'; // Orange
    case 3: return '#eab308'; // Yellow
    case 2: return '#3b82f6'; // Blue
    default: return '#10b981'; // Green
  }
};

// Dynamic Google Maps viewport camera controller
const MapCameraController = ({
  reports,
  selectedReportId
}: {
  reports: any[];
  selectedReportId: string | null;
}) => {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    // Case 1: If a specific report pinpoint is highlighted -> pan & zoom to it
    if (selectedReportId) {
      const selectedReport = reports.find(r => r.id === selectedReportId);
      if (selectedReport && selectedReport.latitude && selectedReport.longitude) {
        map.panTo({ lat: Number(selectedReport.latitude), lng: Number(selectedReport.longitude) });
        map.setZoom(16);
        return;
      }
    }

    // Case 2: No specific report highlighted -> Auto-calculate bounds to display all active filtered markers
    if (reports.length === 0) return;

    const googleObj = (window as any).google;
    if (!googleObj?.maps?.LatLngBounds) return;

    const bounds = new googleObj.maps.LatLngBounds();
    let validReports = 0;

    reports.forEach(report => {
      if (report.latitude && report.longitude) {
        bounds.extend({ lat: Number(report.latitude), lng: Number(report.longitude) });
        validReports++;
      }
    });

    if (validReports > 0) {
      map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
    }
  }, [map, reports, selectedReportId]);

  return null;
};

export default function App() {
  // Role & Navigation
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(() => {
    const hashRole = getRoleFromHash();
    if (hashRole) return hashRole;
    const saved = localStorage.getItem(ROLE_STORAGE_KEY);
    return saved === 'public' || saved === 'official' ? saved : null;
  });
  const [activeTab, setActiveTab] = useState<'report' | 'dashboard'>('report');
  const [showOfficialMap, setShowOfficialMap] = useState(false);

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingInRole, setSigningInRole] = useState<UserRole | null>(null);

  // Firestore reports state
  const [reports, setReports] = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);

  // Report Form state
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [gpsCoordinates, setGpsCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [acquiringGps, setAcquiringGps] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(true);

  // Manual fallback coordinates (if GPS is blocked)
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [showManualCoordinates, setShowManualCoordinates] = useState(false);

  // Report Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStep, setSubmissionStep] = useState<string>('');
  const [submissionResult, setSubmissionResult] = useState<any | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  // Search and Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ReportStatus>('all');

  // Deletion, Status Update, and Notification state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Google Maps Platform & Selection State
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  // Refs for camera / canvas
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const showToast = (msg: string, duration = 3500) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, duration);
  };

  // Listen to Google Maps quota exceeded event
  useEffect(() => {
    const handleQuotaExceeded = () => {
      setQuotaExceeded(true);
    };
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => {
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  // Sync URL hash changes cleanly
  useEffect(() => {
    const handleHashChange = () => {
      const hashRole = getRoleFromHash();
      if (hashRole) {
        setSelectedRole(hashRole);
        localStorage.setItem(ROLE_STORAGE_KEY, hashRole);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Persist role choice
  const chooseRole = (role: UserRole) => {
    setSelectedRole(role);
    localStorage.setItem(ROLE_STORAGE_KEY, role);
    window.location.hash = role === 'official' ? '#/official' : '#/public';
    setSelectedReportId(null);
    setSearchQuery('');
    setSeverityFilter('all');
    setStatusFilter('all');
    if (role === 'public') {
      setActiveTab('report');
    }
  };

  // Handle Google Login for a specific role entry point
  const loginWithGoogle = async (targetRole: UserRole) => {
    setAuthError(null);
    setSigningInRole(targetRole);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
      chooseRole(targetRole);
      showToast(`Signed in to ${targetRole === 'official' ? 'Official Dashboard' : 'Public Dashboard'}.`);
    } catch (err: any) {
      console.error('Google Sign In failed:', err);
      setAuthError(err?.message || 'Google Sign-In failed. Please try again.');
    } finally {
      setSigningInRole(null);
    }
  };

  // Handle Sign Out
  const handleSignOut = async () => {
    try {
      stopCamera();
      await signOut(auth);
      setSelectedRole(null);
      localStorage.removeItem(ROLE_STORAGE_KEY);
      if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setSelectedReportId(null);
      setShowOfficialMap(false);
    } catch (err) {
      console.error('Sign Out failed:', err);
    }
  };

  // Listen to Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Listen to Firestore reports (Real-time updates when authenticated)
  useEffect(() => {
    if (!user) {
      setReports([]);
      setReportsLoading(false);
      return;
    }

    setReportsLoading(true);
    const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: any[] = [];
        snapshot.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        setReports(list);
        setReportsLoading(false);
      },
      (error) => {
        setReportsLoading(false);
        try {
          handleFirestoreError(error, OperationType.LIST, 'reports');
        } catch (e) {
          // Error logged
        }
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Toggle report resolution status (Official Dashboard)
  const toggleReportResolution = async (report: any) => {
    if (!user) return;
    const currentStatus = normalizeStatus(report.status);
    const nextStatus: ReportStatus = currentStatus === 'Work Done' ? 'Pending / Not Done' : 'Work Done';
    const officialIdentifier = user.displayName || user.email || 'Municipal Official';
    const nextResolvedBy = nextStatus === 'Work Done' ? officialIdentifier : null;
    const nextResolvedAt = nextStatus === 'Work Done' ? new Date().toISOString() : null;

    setUpdatingStatusId(report.id);

    // Optimistic local update
    setReports(prev =>
      prev.map(r =>
        r.id === report.id
          ? { ...r, status: nextStatus, resolvedBy: nextResolvedBy, resolvedAt: nextResolvedAt }
          : r
      )
    );

    try {
      await updateDoc(doc(db, 'reports', report.id), {
        status: nextStatus,
        resolvedBy: nextResolvedBy,
        resolvedAt: nextResolvedAt
      });
      showToast(
        nextStatus === 'Work Done'
          ? `Marked "${report.signType}" as Work Done.`
          : `Reopened "${report.signType}" as Pending / Not Done.`
      );
    } catch (err: any) {
      console.error('Failed to update report status:', err);
      // Rollback optimistic change on failure
      setReports(prev =>
        prev.map(r =>
          r.id === report.id
            ? { ...r, status: report.status, resolvedBy: report.resolvedBy ?? null, resolvedAt: report.resolvedAt ?? null }
            : r
        )
      );
      showToast('Failed to update resolution status: ' + (err.message || String(err)), 5000);
      try {
        handleFirestoreError(err, OperationType.UPDATE, 'reports/' + report.id);
      } catch (e) {
        // Error logged
      }
    } finally {
      setUpdatingStatusId(null);
    }
  };

  // Delete report log from Firestore
  const executeDeleteLog = async (reportId: string) => {
    setDeletingId(reportId);
    try {
      setReports(prev => prev.filter(r => r.id !== reportId));
      await deleteDoc(doc(db, 'reports', reportId));
      showToast('Report log deleted successfully.');
    } catch (err: any) {
      console.error('Failed to delete report:', err);
      showToast('Failed to delete report: ' + (err.message || String(err)), 5000);
      try {
        handleFirestoreError(err, OperationType.DELETE, 'reports/' + reportId);
      } catch (e) {
        // Error logged
      }
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  // Start Live Video Stream from Camera
  const startCamera = async () => {
    try {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });

      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setIsCameraActive(true);
      setSubmissionError(null);
    } catch (err) {
      console.warn('Camera stream capture failed, switching to file upload mode:', err);
      setIsCameraActive(false);
    }
  };

  // Stop Camera Video Stream
  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
  };

  // Trigger camera start only when authenticated in Public Dashboard -> Report tab
  useEffect(() => {
    if (user && selectedRole === 'public' && activeTab === 'report' && isCameraActive && !capturedImage) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [user, selectedRole, activeTab, isCameraActive, capturedImage]);

  // Helper to downscale and compress images to fit inside Firestore 1MB document limit
  const compressAndResizeImage = (dataUrl: string, maxWidth = 800, maxHeight = 800): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.65);
        resolve(compressedDataUrl);
      };
      img.onerror = () => {
        resolve(dataUrl);
      };
    });
  };

  // Capture Image Frame from live video element
  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');

    if (context) {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      stopCamera();

      compressAndResizeImage(dataUrl, 800, 800).then((compressed) => {
        setCapturedImage(compressed);
        acquireCoordinates();
      });
    }
  };

  // Acquire exact GPS Coordinates of user
  const acquireCoordinates = () => {
    setAcquiringGps(true);
    setGpsError(null);

    if (!navigator.geolocation) {
      setGpsError('Geolocation is not supported by your browser.');
      setAcquiringGps(false);
      setShowManualCoordinates(true);
      return;
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    };

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsCoordinates({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
        setManualLat(position.coords.latitude.toString());
        setManualLng(position.coords.longitude.toString());
        setAcquiringGps(false);
      },
      (error) => {
        let msg = 'Unable to fetch your precise GPS location.';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            msg = 'Location permission was denied. Please input GPS coordinates manually.';
            break;
          case error.POSITION_UNAVAILABLE:
            msg = 'GPS signal unavailable. Please input coordinates manually.';
            break;
          case error.TIMEOUT:
            msg = 'GPS lookup timed out. Please input coordinates manually.';
            break;
        }
        setGpsError(msg);
        setAcquiringGps(false);
        setShowManualCoordinates(true);
      },
      options
    );
  };

  // Handlers for File Input selector
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const rawResult = reader.result as string;
        compressAndResizeImage(rawResult, 800, 800).then((compressed) => {
          setCapturedImage(compressed);
          acquireCoordinates();
        });
      };
      reader.readAsDataURL(file);
    }
  };

  // Retry or retake picture
  const handleRetake = () => {
    setCapturedImage(null);
    setSubmissionError(null);
    setSubmissionResult(null);
    if (isCameraActive) {
      startCamera();
    }
  };

  // Submit Report to Server
  const submitDamageReport = async () => {
    if (!capturedImage) {
      setSubmissionError('Please capture or upload an image first.');
      return;
    }

    let lat = gpsCoordinates?.latitude;
    let lng = gpsCoordinates?.longitude;

    if (showManualCoordinates) {
      const parsedLat = parseFloat(manualLat);
      const parsedLng = parseFloat(manualLng);
      if (isNaN(parsedLat) || isNaN(parsedLng)) {
        setSubmissionError('Please enter valid numeric latitude and longitude coordinates.');
        return;
      }
      lat = parsedLat;
      lng = parsedLng;
    }

    if (lat === undefined || lng === undefined) {
      setSubmissionError('GPS coordinates are required to submit a hazard report.');
      return;
    }

    setIsSubmitting(true);
    setSubmissionError(null);
    setSubmissionResult(null);

    try {
      setSubmissionStep('Step 1/3: Encoding photo and preparing GPS payload...');
      await new Promise(resolve => setTimeout(resolve, 500));

      setSubmissionStep('Step 2/3: Analyzing road sign & assessing damage with Gemini AI...');

      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: capturedImage,
          latitude: lat,
          longitude: lng,
          userId: user?.uid,
          userName: user?.displayName || user?.email || 'Community Scout',
          userEmail: user?.email
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details || 'Failed to analyze or submit damage report.');
      }

      setSubmissionStep('Step 3/3: Finalizing database registration...');
      await new Promise(resolve => setTimeout(resolve, 400));

      setSubmissionResult(data);
      setTimeout(() => {
        setActiveTab('dashboard');
        setCapturedImage(null);
        setSubmissionResult(null);
      }, 3500);
    } catch (err: any) {
      console.error('Submission failed:', err);
      setSubmissionError(err instanceof Error ? err.message : 'Failed to connect to the analysis backend.');
    } finally {
      setIsSubmitting(false);
      setSubmissionStep('');
    }
  };

  // Helper stats computed from reports
  const totalCount = reports.length;
  const criticalCount = reports.filter(r => r.severityScore === 5).length;
  const workDoneCount = reports.filter(r => normalizeStatus(r.status) === 'Work Done').length;
  const pendingCount = reports.filter(r => normalizeStatus(r.status) === 'Pending / Not Done').length;
  const criticalPendingCount = reports.filter(
    r => r.severityScore === 5 && normalizeStatus(r.status) === 'Pending / Not Done'
  ).length;

  const listToDisplay = reports.filter(r => {
    const qLower = searchQuery.toLowerCase();
    const matchesSearch =
      !qLower ||
      (r.signType || '').toLowerCase().includes(qLower) ||
      (r.damageDescription || '').toLowerCase().includes(qLower) ||
      (r.userName || '').toLowerCase().includes(qLower) ||
      (r.userEmail || '').toLowerCase().includes(qLower);
    const matchesSeverity = severityFilter === 'all' || String(r.severityScore) === severityFilter;
    const matchesStatus = statusFilter === 'all' || normalizeStatus(r.status) === statusFilter;
    return matchesSearch && matchesSeverity && matchesStatus;
  });

  const renderSeverityPill = (score: number) => {
    let pillClass = 'bg-emerald-50 text-emerald-800 border-emerald-200';
    if (score === 5) {
      pillClass = 'bg-red-50 text-red-800 border-red-200';
    } else if (score === 4) {
      pillClass = 'bg-orange-50 text-orange-800 border-orange-200';
    } else if (score === 3) {
      pillClass = 'bg-yellow-50 text-yellow-800 border-yellow-200';
    } else if (score === 2) {
      pillClass = 'bg-blue-50 text-blue-800 border-blue-200';
    }

    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xxs font-bold uppercase border ${pillClass}`}>
        Level {score}
      </span>
    );
  };

  const renderStatusBadge = (status?: string | null) => {
    const normalized = normalizeStatus(status);
    if (normalized === 'Work Done') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
          Work Done
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
        <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
        Pending / Not Done
      </span>
    );
  };

  const renderDeleteCell = (report: any) => (
    confirmDeleteId === report.id ? (
      <div className="flex items-center gap-1.5 animate-fade-in">
        <button
          onClick={() => executeDeleteLog(report.id)}
          disabled={deletingId === report.id}
          className="text-white font-bold bg-red-600 hover:bg-red-700 disabled:bg-red-300 px-2.5 py-1 rounded-full text-xxs transition-colors shadow-sm cursor-pointer flex items-center gap-1"
        >
          {deletingId === report.id ? (
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
          ) : (
            <span>Confirm</span>
          )}
        </button>
        <button
          onClick={() => setConfirmDeleteId(null)}
          disabled={deletingId === report.id}
          className="text-slate-600 hover:text-slate-900 font-semibold bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-full text-xxs transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    ) : (
      <button
        onClick={() => setConfirmDeleteId(report.id)}
        disabled={deletingId === report.id}
        className="text-red-600 hover:text-red-950 font-bold hover:underline disabled:text-slate-400 flex items-center justify-center gap-1 cursor-pointer bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-full border border-red-200 transition-colors"
      >
        {deletingId === report.id ? (
          <span className="w-3.5 h-3.5 border-2 border-red-600 border-t-transparent rounded-full animate-spin"></span>
        ) : (
          <span className="text-xxs">Delete</span>
        )}
      </button>
    )
  );

  const renderGoogleMapCard = (title: string) => (
    <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MapPin className="text-emerald-700 w-5 h-5" />
          <h3 className="font-extrabold text-slate-800 text-sm">{title}</h3>
        </div>
        <div className="text-xxs font-black uppercase text-slate-400 flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          Real-time pins active ({listToDisplay.length})
        </div>
      </div>

      {/* Google Map container element */}
      <div className="w-full h-[420px] bg-slate-100 z-10 relative">
        <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY || 'AIzaSyBh4lb98ur7dM2vN3_uVTBn9mKoxugur1I'} libraries={['marker']}>
          <Map
            defaultZoom={listToDisplay.length > 0 ? 11 : 4}
            defaultCenter={
              listToDisplay.length > 0 && listToDisplay[0].latitude && listToDisplay[0].longitude
                ? { lat: Number(listToDisplay[0].latitude), lng: Number(listToDisplay[0].longitude) }
                : { lat: 37.7749, lng: -122.4194 }
            }
            mapId="DEMO_MAP_ID"
            gestureHandling="greedy"
            disableDefaultUI={false}
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
            style={{ width: '100%', height: '100%' }}
          >
            <MapCameraController reports={listToDisplay} selectedReportId={selectedReportId} />

            {listToDisplay.map((report) => {
              if (!report.latitude || !report.longitude) return null;

              const markerColor = getSeverityColor(Number(report.severityScore));
              const isResolved = normalizeStatus(report.status) === 'Work Done';

              return (
                <div key={report.id}>
                  <AdvancedMarker
                    position={{ lat: Number(report.latitude), lng: Number(report.longitude) }}
                    title={report.signType}
                    onClick={() => setSelectedReportId(report.id)}
                  >
                    <Pin
                      background={isResolved ? '#10b981' : markerColor}
                      borderColor="#ffffff"
                      glyphColor="#ffffff"
                      scale={1.2}
                    />
                  </AdvancedMarker>

                  {selectedReportId === report.id && (
                    <InfoWindow
                      position={{ lat: Number(report.latitude), lng: Number(report.longitude) }}
                      onCloseClick={() => setSelectedReportId(null)}
                    >
                      <div className="p-1 font-sans text-slate-800" style={{ width: '230px' }}>
                        <img
                          src={report.imageUrl}
                          alt={report.signType}
                          className="w-full h-24 object-cover rounded-md mb-2 border border-slate-100"
                        />
                        <h4 className="font-extrabold text-sm text-slate-900 mb-1 leading-tight">{report.signType}</h4>
                        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                          <span
                            className="inline-block px-2 py-0.5 text-[9px] font-bold uppercase rounded text-white"
                            style={{ backgroundColor: markerColor }}
                          >
                            Severity: Level {report.severityScore}
                          </span>
                          <span
                            className={`inline-block px-2 py-0.5 text-[9px] font-bold uppercase rounded ${
                              isResolved
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {isResolved ? 'Work Done' : 'Pending'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 leading-snug line-clamp-3 mb-1 bg-slate-50 p-1.5 rounded border border-slate-100">
                          {report.damageDescription}
                        </p>
                        <div className="flex items-center justify-between text-[10px] text-slate-500 font-medium mt-1">
                          <span>By: <strong>{report.userName || 'Community Scout'}</strong></span>
                          <span className="font-mono text-slate-400">
                            {Number(report.latitude).toFixed(3)}, {Number(report.longitude).toFixed(3)}
                          </span>
                        </div>
                      </div>
                    </InfoWindow>
                  )}
                </div>
              );
            })}
          </Map>
        </APIProvider>
      </div>

      {/* Map Legend */}
      <div className="bg-slate-50 border-t border-slate-200 px-6 py-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 font-semibold items-center justify-center">
        <span className="text-[10px] font-black uppercase text-slate-400 mr-2">Severity Scale:</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-emerald-500"></span>1: Minor / Work Done</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500"></span>2: Low</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-yellow-500"></span>3: Moderate</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-orange-500"></span>4: High</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500"></span>5: Critical</span>
      </div>
    </div>
  );

  const isLandingGate = !user || !selectedRole;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col antialiased">
      {/* Google Maps Quota Warning Banner */}
      {quotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-[2001] shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Header Banner */}
      <header className={`${selectedRole === 'official' && user ? 'bg-slate-900' : 'bg-emerald-900'} text-white shadow-md sticky top-0 z-[1000] transition-colors`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="bg-amber-500 p-2 rounded-lg text-slate-950 flex items-center justify-center shadow-inner">
              {selectedRole === 'official' && user ? (
                <ShieldCheck className="w-5 h-5" />
              ) : (
                <ShieldAlert className="w-5 h-5 animate-pulse" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-black tracking-tight leading-none">SignAlert</h1>
                {user && selectedRole && (
                  <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md ${
                    selectedRole === 'official'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30'
                      : 'bg-emerald-700/80 text-emerald-100 border border-emerald-500/40'
                  }`}>
                    {selectedRole === 'official' ? 'Official Dashboard' : 'Public Dashboard'}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-emerald-200/90 mt-0.5 tracking-wider font-semibold uppercase">
                {selectedRole === 'official' && user
                  ? 'Municipal Operations & Resolution Portal'
                  : 'Community Safety Network'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {authLoading ? (
              <div className="w-6 h-6 border-2 border-emerald-300 border-t-white rounded-full animate-spin"></div>
            ) : user ? (
              <div className="flex items-center gap-2.5">
                {selectedRole && (
                  <button
                    onClick={() => chooseRole(selectedRole === 'official' ? 'public' : 'official')}
                    title="Switch Dashboard Role"
                    className="hidden md:inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-colors cursor-pointer"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                    <span>Switch to {selectedRole === 'official' ? 'Public Dashboard' : 'Official Dashboard'}</span>
                  </button>
                )}

                <div className="flex items-center gap-2.5 bg-white/10 py-1.5 px-3 rounded-full border border-white/15">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt={user.displayName || 'User'} className="w-7 h-7 rounded-full border border-white shrink-0" />
                  ) : (
                    <div className="w-7 h-7 bg-amber-500 rounded-full flex items-center justify-center text-slate-950 font-bold text-xs uppercase shrink-0">
                      {user.displayName?.charAt(0) || user.email?.charAt(0)}
                    </div>
                  )}
                  <div className="hidden sm:block text-left leading-tight">
                    <p className="text-xs font-bold leading-none text-white">{user.displayName || 'Authenticated User'}</p>
                    <p className="text-[10px] text-emerald-200/90 mt-0.5 truncate max-w-[180px]">{user.email || (selectedRole === 'official' ? 'Municipal Official' : 'Community Scout')}</p>
                  </div>
                  <button
                    onClick={handleSignOut}
                    title="Sign Out"
                    className="text-emerald-200 hover:text-white transition-colors ml-1 p-1 cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* PRE-LOGIN ROLE SELECTION & AUTH GATE VIEW */}
      {isLandingGate ? (
        <main className="flex-grow max-w-5xl w-full mx-auto px-4 sm:px-6 py-12 flex flex-col items-center justify-center">
          <div className="text-center max-w-2xl mx-auto mb-10">
            <div className="bg-emerald-100/80 p-4 rounded-3xl text-emerald-800 mb-5 shadow-sm inline-flex items-center justify-center">
              <ShieldAlert className="w-11 h-11 text-emerald-800" />
            </div>

            <h2 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight leading-tight">
              Road Sign Damage Monitor
            </h2>

            <p className="text-base text-slate-600 mt-3 leading-relaxed">
              Select your portal below and sign in with Google to continue. Citizens can report and track road hazards, while municipal officials manage and resolve active complaints.
            </p>
          </div>

          {authError && (
            <div className="mb-6 max-w-2xl w-full bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-2xl text-xs font-semibold flex items-center gap-2.5">
              <XCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          {/* Two Primary Role Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-4xl">
            {/* Option 1: Public Dashboard */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm hover:shadow-lg transition-all p-7 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-5">
                  <div className="bg-emerald-100 text-emerald-800 p-3.5 rounded-2xl">
                    <Users className="w-7 h-7" />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Citizen Portal
                  </span>
                </div>

                <h3 className="text-xl font-black text-slate-900">Public Dashboard</h3>
                <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                  Designed for citizens to submit road sign damage reports with AI damage scoring &amp; GPS coordinates, and view community infrastructure reports on the live map.
                </p>

                <ul className="mt-5 space-y-2 text-xs text-slate-600 font-medium">
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Snap or upload road sign damage photos</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Automatic AI severity assessment &amp; GPS tagging</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Live Public Dashboard map &amp; repair status tracking</span>
                  </li>
                </ul>
              </div>

              <div className="mt-7 pt-5 border-t border-slate-100">
                {user ? (
                  <button
                    onClick={() => chooseRole('public')}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold text-sm py-3.5 px-6 rounded-full transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2.5 cursor-pointer"
                  >
                    <LayoutDashboard className="w-4 h-4" />
                    <span>Enter Public Dashboard</span>
                  </button>
                ) : (
                  <button
                    onClick={() => loginWithGoogle('public')}
                    disabled={signingInRole !== null}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 disabled:bg-emerald-400 text-white font-extrabold text-sm py-3.5 px-6 rounded-full transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-3 cursor-pointer"
                  >
                    {signingInRole === 'public' ? (
                      <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    ) : (
                      <img
                        src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                        alt="Google"
                        className="w-5 h-5 bg-white rounded-full p-0.5"
                      />
                    )}
                    <span>Sign in with Google — Public</span>
                  </button>
                )}
              </div>
            </div>

            {/* Option 2: Official Dashboard */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm hover:shadow-lg transition-all p-7 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-5">
                  <div className="bg-slate-900 text-amber-400 p-3.5 rounded-2xl">
                    <ShieldCheck className="w-7 h-7" />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                    Municipal Officers &amp; Admins
                  </span>
                </div>

                <h3 className="text-xl font-black text-slate-900">Official Dashboard</h3>
                <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                  Designed for municipal officers and administrators to review all submitted complaints, audit hazard severity, and mark repairs as Work Done or Pending.
                </p>

                <ul className="mt-5 space-y-2 text-xs text-slate-600 font-medium">
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-slate-800 shrink-0" />
                    <span>Dedicated municipal damage complaints registry</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-slate-800 shrink-0" />
                    <span>Toggle complaints between Work Done &amp; Pending</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-slate-800 shrink-0" />
                    <span>Real-time status sync across public &amp; official views</span>
                  </li>
                </ul>
              </div>

              <div className="mt-7 pt-5 border-t border-slate-100">
                {user ? (
                  <button
                    onClick={() => chooseRole('official')}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-sm py-3.5 px-6 rounded-full transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2.5 cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-amber-400" />
                    <span>Enter Official Dashboard</span>
                  </button>
                ) : (
                  <button
                    onClick={() => loginWithGoogle('official')}
                    disabled={signingInRole !== null}
                    className="w-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-500 text-white font-extrabold text-sm py-3.5 px-6 rounded-full transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-3 cursor-pointer"
                  >
                    {signingInRole === 'official' ? (
                      <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    ) : (
                      <img
                        src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                        alt="Google"
                        className="w-5 h-5 bg-white rounded-full p-0.5"
                      />
                    )}
                    <span>Sign in with Google — Official</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      ) : selectedRole === 'official' ? (
        /* ======================== OFFICIAL DASHBOARD VIEW ======================== */
        <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          {/* Official Portal Banner */}
          <div className="bg-slate-900 text-white rounded-3xl p-6 shadow-md border border-slate-800 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-amber-400" />
                <h2 className="text-xl font-black tracking-tight">Official Dashboard — Municipal Moderation Registry</h2>
              </div>
              <p className="text-xs text-slate-300">
                Signed in as <span className="font-bold text-white">{user.displayName || 'Officer'}</span> ({user.email}). Toggle each complaint checkbox below to mark field repairs as <strong className="text-emerald-400">Work Done</strong> or <strong className="text-amber-300">Pending / Not Done</strong>.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                onClick={() => setShowOfficialMap(prev => !prev)}
                className="inline-flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 transition-colors cursor-pointer"
              >
                <MapIcon className="w-4 h-4 text-emerald-400" />
                <span>{showOfficialMap ? 'Hide Map View' : 'Show Map View'}</span>
              </button>
              <button
                onClick={() => chooseRole('public')}
                className="md:hidden inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white border border-white/15 transition-colors cursor-pointer"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                <span>Public View</span>
              </button>
            </div>
          </div>

          {/* Official KPI metrics bar */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
              <div className="bg-slate-100 p-3 rounded-xl text-slate-700">
                <Activity className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Total Complaints</span>
                <span className="text-xl font-extrabold text-slate-900 leading-none mt-1 inline-block">{reportsLoading ? '...' : totalCount}</span>
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
              <div className="bg-amber-100 p-3 rounded-xl text-amber-700">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Pending / Not Done</span>
                <span className="text-xl font-extrabold text-amber-700 leading-none mt-1 inline-block">{reportsLoading ? '...' : pendingCount}</span>
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
              <div className="bg-emerald-100 p-3 rounded-xl text-emerald-700">
                <CheckCircle className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Work Done</span>
                <span className="text-xl font-extrabold text-emerald-700 leading-none mt-1 inline-block">{reportsLoading ? '...' : workDoneCount}</span>
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
              <div className="bg-red-100 p-3 rounded-xl text-red-700">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Critical Pending</span>
                <span className="text-xl font-extrabold text-red-600 leading-none mt-1 inline-block">{reportsLoading ? '...' : criticalPendingCount}</span>
              </div>
            </div>
          </div>

          {/* Optional Map View for Official Inspection */}
          {showOfficialMap && renderGoogleMapCard('Official Inspection Map')}

          {/* Official Complaints Moderation Table */}
          <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
            <div className="p-6 border-b border-slate-200 space-y-4 lg:space-y-0 lg:flex lg:items-center lg:justify-between lg:gap-4">
              <div>
                <h3 className="font-extrabold text-slate-900 text-base">Submitted Damage Complaints Registry</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Review community submissions and check off completed municipal repairs
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute top-1/2 left-3 transform -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search sign, damage, reporter..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 pr-4 py-1.5 border border-slate-300 rounded-full text-xs w-full sm:w-56 focus:outline-none focus:border-slate-800 focus:ring-1 focus:ring-slate-800"
                  />
                </div>

                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'all' | ReportStatus)}
                  className="border border-slate-300 rounded-full text-xs px-3 py-1.5 focus:outline-none focus:border-slate-800 font-bold bg-white"
                >
                  <option value="all">All Statuses</option>
                  <option value="Pending / Not Done">Pending / Not Done</option>
                  <option value="Work Done">Work Done</option>
                </select>

                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="border border-slate-300 rounded-full text-xs px-3 py-1.5 focus:outline-none focus:border-slate-800 font-bold bg-white"
                >
                  <option value="all">All Severities</option>
                  <option value="5">Severity 5 (Critical)</option>
                  <option value="4">Severity 4 (High)</option>
                  <option value="3">Severity 3 (Moderate)</option>
                  <option value="2">Severity 2 (Low)</option>
                  <option value="1">Severity 1 (Minor)</option>
                </select>
              </div>
            </div>

            {reportsLoading ? (
              <div className="p-12 text-center flex flex-col items-center">
                <div className="w-8 h-8 border-2 border-slate-800 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-xs text-slate-400 mt-2.5">Loading complaints registry...</p>
              </div>
            ) : listToDisplay.length === 0 ? (
              <div className="p-12 text-center max-w-sm mx-auto">
                <div className="bg-slate-100 p-4 rounded-full text-slate-400 w-14 h-14 mx-auto flex items-center justify-center mb-4">
                  <Search className="w-6 h-6" />
                </div>
                <h4 className="font-extrabold text-slate-800 text-sm">
                  {reports.length === 0 ? 'No reports submitted yet' : 'No matching complaints found'}
                </h4>
                <p className="text-xs text-slate-500 mt-1">
                  {reports.length === 0
                    ? 'Community damage reports will appear here as soon as citizens submit them.'
                    : 'Try adjusting your search query, status filter, or severity filter.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sl. No</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Resolution Status</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sign Preview</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sign Type</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Damage Description</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Severity</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Location</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Reporter &amp; Date</th>
                      <th scope="col" className="px-5 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-slate-150 text-slate-700">
                    {listToDisplay.map((report, index) => {
                      const isWorkDone = normalizeStatus(report.status) === 'Work Done';
                      const isUpdating = updatingStatusId === report.id;

                      return (
                        <tr
                          key={report.id}
                          className={`transition-colors ${
                            isWorkDone ? 'bg-emerald-50/30 hover:bg-emerald-50/50' : 'hover:bg-slate-50/70'
                          }`}
                        >
                          <td className="px-5 py-4 whitespace-nowrap text-xs font-bold text-slate-500">
                            {index + 1}
                          </td>

                          {/* Interactive Checkbox / Toggle for Work Done vs Pending */}
                          <td className="px-5 py-4 whitespace-nowrap">
                            <div className="flex flex-col gap-1">
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={isWorkDone}
                                disabled={isUpdating}
                                onClick={() => toggleReportResolution(report)}
                                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer disabled:opacity-60 ${
                                  isWorkDone
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 shadow-sm'
                                    : 'bg-amber-50 hover:bg-amber-100 text-amber-900 border-amber-300'
                                }`}
                              >
                                {isUpdating ? (
                                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0"></span>
                                ) : isWorkDone ? (
                                  <CheckSquare className="w-4 h-4 shrink-0" />
                                ) : (
                                  <Square className="w-4 h-4 shrink-0" />
                                )}
                                <span>{isWorkDone ? 'Work Done' : 'Pending / Not Done'}</span>
                              </button>
                              {isWorkDone && report.resolvedBy && (
                                <span className="text-[10px] text-emerald-700 font-medium pl-1">
                                  By {report.resolvedBy}
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap">
                            <img
                              src={report.imageUrl}
                              alt={report.signType}
                              className="w-12 h-12 object-cover rounded-lg border border-slate-200 shadow-sm"
                            />
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap text-xs font-extrabold text-slate-900">
                            {report.signType}
                          </td>

                          <td className="px-5 py-4 text-xs font-medium max-w-xs">
                            <p className="line-clamp-2" title={report.damageDescription}>
                              {report.damageDescription}
                            </p>
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap">
                            {renderSeverityPill(report.severityScore)}
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap">
                            <button
                              onClick={() => {
                                setSelectedReportId(report.id);
                                setShowOfficialMap(true);
                              }}
                              className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline flex items-center gap-1.5 cursor-pointer bg-slate-50 hover:bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200 transition-colors"
                              title="Open location on map"
                            >
                              <MapPin className="w-3.5 h-3.5 shrink-0" />
                              <span className="font-mono">
                                {Number(report.latitude).toFixed(4)}, {Number(report.longitude).toFixed(4)}
                              </span>
                            </button>
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap text-xs">
                            <div className="font-semibold text-slate-800 truncate max-w-[150px]">
                              {report.userName || 'Community Scout'}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {new Date(report.timestamp).toLocaleDateString()} at{' '}
                              {new Date(report.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </td>

                          <td className="px-5 py-4 whitespace-nowrap text-xs">
                            {renderDeleteCell(report)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      ) : (
        /* ======================== PUBLIC DASHBOARD VIEW ======================== */
        <>
          {/* Navigation tabs */}
          <div className="bg-white border-b border-slate-200 sticky top-16 z-50">
            <div className="max-w-3xl mx-auto px-4 flex">
              <button
                onClick={() => setActiveTab('report')}
                className={`flex-1 py-4 text-center font-bold text-sm flex items-center justify-center gap-2 border-b-2 transition-all cursor-pointer ${
                  activeTab === 'report'
                    ? 'border-emerald-600 text-emerald-700 bg-emerald-50/20'
                    : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                }`}
              >
                <Camera className="w-4 h-4" />
                Report Sign Damage
              </button>
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`flex-1 py-4 text-center font-bold text-sm flex items-center justify-center gap-2 border-b-2 transition-all cursor-pointer ${
                  activeTab === 'dashboard'
                    ? 'border-emerald-600 text-emerald-700 bg-emerald-50/20'
                    : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                }`}
              >
                <LayoutDashboard className="w-4 h-4" />
                Public Dashboard
              </button>
            </div>
          </div>

          {/* Main Content Areas */}
          <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
            {/* VIEW: REPORT DAMAGE */}
            {activeTab === 'report' && (
              <div className="max-w-2xl mx-auto">
                <div className="mb-6 text-center">
                  <h2 className="text-2xl font-extrabold text-slate-900 leading-tight">Report Damaged Infrastructure</h2>
                  <p className="text-sm text-slate-500 mt-1 max-w-lg mx-auto">
                    Capture a clear photograph of any fallen, rusted, graffitied, or vandalized road sign. Gemini AI will analyze the damage automatically.
                  </p>
                </div>

                {submissionError && (
                  <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded-r-xl flex gap-3 shadow-sm animate-shake">
                    <XCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-bold text-red-800 text-sm">Submission Error</h4>
                      <p className="text-xs text-red-700 mt-1 leading-relaxed">{submissionError}</p>
                    </div>
                  </div>
                )}

                {isSubmitting && (
                  <div className="fixed inset-0 bg-slate-900/70 flex items-center justify-center p-4 z-[9999] backdrop-blur-sm">
                    <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl text-center flex flex-col items-center">
                      <div className="relative mb-6">
                        <div className="w-16 h-16 border-4 border-emerald-100 border-t-emerald-600 rounded-full animate-spin"></div>
                        <AlertTriangle className="w-6 h-6 text-amber-500 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 animate-bounce" />
                      </div>
                      <h3 className="text-lg font-black text-slate-900">Processing Infrastructure Assessment</h3>
                      <p className="text-xs font-semibold text-emerald-600 mt-2 bg-emerald-50 px-3 py-1 rounded-full">{submissionStep}</p>
                      <p className="text-xs text-slate-400 mt-4 leading-relaxed">
                        Analyzing the visual damage signature, rating the hazard severity out of 5, and updating the neighborhood safety registry.
                      </p>
                    </div>
                  </div>
                )}

                {submissionResult ? (
                  <div className="bg-white rounded-3xl border border-emerald-100 shadow-xl overflow-hidden animate-fade-in">
                    <div className="bg-emerald-600 p-6 text-white text-center flex flex-col items-center">
                      <div className="bg-white/20 p-3 rounded-full mb-3">
                        <CheckCircle className="w-10 h-10 text-white" />
                      </div>
                      <h3 className="text-xl font-extrabold">Report Approved &amp; Registered!</h3>
                      <p className="text-xs text-emerald-100 mt-1">Hazard logged in neighborhood database</p>
                    </div>

                    <div className="p-6 space-y-6">
                      <div className="flex flex-col sm:flex-row gap-5">
                        <img
                          src={submissionResult.imageUrl}
                          alt="Submitted road sign"
                          className="w-full sm:w-40 h-40 object-cover rounded-2xl border border-slate-200 shadow-sm shrink-0"
                        />
                        <div className="space-y-3 flex-grow">
                          <div>
                            <span className="text-[10px] font-black uppercase text-emerald-600 tracking-wider">Identified Sign Type</span>
                            <h4 className="text-lg font-extrabold text-slate-900">{submissionResult.signType}</h4>
                          </div>

                          <div>
                            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">Report ID</span>
                            <p className="text-xs font-mono text-slate-500 break-all">{submissionResult.id}</p>
                          </div>

                          <div className="flex gap-4">
                            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100 flex-1">
                              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider block">Latitude</span>
                              <span className="text-xs font-bold font-mono text-slate-800">{Number(submissionResult.latitude).toFixed(5)}</span>
                            </div>
                            <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100 flex-1">
                              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider block">Longitude</span>
                              <span className="text-xs font-bold font-mono text-slate-800">{Number(submissionResult.longitude).toFixed(5)}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 space-y-4">
                        <div>
                          <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block mb-1">Visual Damage Profile</span>
                          <p className="text-sm text-slate-700 leading-relaxed font-medium">{submissionResult.damageDescription}</p>
                        </div>

                        <div className="border-t border-slate-200 pt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <div>
                            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider block">Severity Assessment</span>
                            <p className="text-xs text-slate-500">Scaled 1 (low) to 5 (extreme hazard)</p>
                          </div>

                          <div className="flex items-center gap-2">
                            {Array.from({ length: 5 }).map((_, i) => {
                              const isActive = i < submissionResult.severityScore;
                              return (
                                <div
                                  key={i}
                                  className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs ${
                                    isActive
                                      ? submissionResult.severityScore === 5
                                        ? 'bg-red-500 text-white'
                                        : submissionResult.severityScore >= 4
                                          ? 'bg-orange-500 text-white'
                                          : 'bg-yellow-500 text-white'
                                      : 'bg-slate-200 text-slate-400'
                                  }`}
                                >
                                  {i + 1}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="text-center">
                        <button
                          onClick={handleRetake}
                          className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-6 py-3 rounded-full font-bold text-sm transition-all shadow-md cursor-pointer"
                        >
                          <RefreshCw className="w-4 h-4" />
                          Report Another Sign
                        </button>
                        <p className="text-[11px] text-slate-400 mt-2.5">Redirecting to the Public Dashboard map in a few seconds...</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-3xl border border-slate-200 shadow-md overflow-hidden">
                    {capturedImage ? (
                      <div className="p-6 space-y-6 animate-fade-in">
                        <div className="relative rounded-2xl overflow-hidden border border-slate-200 max-h-96 bg-slate-900 flex justify-center">
                          <img src={capturedImage} alt="Captured preview" className="max-w-full max-h-96 object-contain" />
                          <div className="absolute top-3 left-3 bg-slate-900/80 backdrop-blur-sm text-white py-1 px-3 rounded-full text-xs font-bold flex items-center gap-1.5">
                            <ImageIcon className="w-3.5 h-3.5 text-amber-400" />
                            Preview Locked
                          </div>
                        </div>

                        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`p-1.5 rounded-lg ${gpsCoordinates ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                                <Compass className={`w-4 h-4 ${acquiringGps ? 'animate-spin' : ''}`} />
                              </div>
                              <div>
                                <h4 className="font-bold text-sm text-slate-900">
                                  {acquiringGps ? 'Acquiring Precise GPS...' : gpsCoordinates ? 'GPS Location Locked' : 'GPS Coordinates Unavailable'}
                                </h4>
                                <p className="text-xxs text-slate-500">Coordinates are synchronized with photo timestamps</p>
                              </div>
                            </div>

                            {!acquiringGps && (
                              <button
                                onClick={acquireCoordinates}
                                className="text-xs bg-white border border-slate-300 hover:bg-slate-50 font-bold px-3 py-1.5 rounded-lg text-slate-700 transition-colors cursor-pointer flex items-center gap-1"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Refresh
                              </button>
                            )}
                          </div>

                          {acquiringGps ? (
                            <div className="space-y-2">
                              <div className="h-4 bg-slate-200 animate-pulse rounded-md w-3/4"></div>
                            </div>
                          ) : gpsCoordinates && !showManualCoordinates ? (
                            <div className="grid grid-cols-2 gap-4">
                              <div className="bg-white p-3 rounded-xl border border-slate-150">
                                <span className="text-[10px] text-slate-400 block uppercase font-bold tracking-wider">Latitude</span>
                                <span className="text-sm font-bold text-slate-800 font-mono">{gpsCoordinates.latitude.toFixed(6)}</span>
                              </div>
                              <div className="bg-white p-3 rounded-xl border border-slate-150">
                                <span className="text-[10px] text-slate-400 block uppercase font-bold tracking-wider">Longitude</span>
                                <span className="text-sm font-bold text-slate-800 font-mono">{gpsCoordinates.longitude.toFixed(6)}</span>
                              </div>
                            </div>
                          ) : (
                            <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-3.5 space-y-3">
                              {gpsError && (
                                <p className="text-xs text-amber-800 leading-relaxed font-medium">{gpsError}</p>
                              )}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="text-[10px] font-black uppercase text-slate-500 tracking-wider block mb-1">Latitude Coordinate</label>
                                  <input
                                    type="number"
                                    step="any"
                                    value={manualLat}
                                    onChange={(e) => setManualLat(e.target.value)}
                                    placeholder="e.g. 37.7749"
                                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-mono focus:border-emerald-500 focus:outline-none"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] font-black uppercase text-slate-500 tracking-wider block mb-1">Longitude Coordinate</label>
                                  <input
                                    type="number"
                                    step="any"
                                    value={manualLng}
                                    onChange={(e) => setManualLng(e.target.value)}
                                    placeholder="e.g. -122.4194"
                                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-mono focus:border-emerald-500 focus:outline-none"
                                  />
                                </div>
                              </div>
                              <button
                                onClick={() => {
                                  const latNum = parseFloat(manualLat);
                                  const lngNum = parseFloat(manualLng);
                                  if (!isNaN(latNum) && !isNaN(lngNum)) {
                                    setGpsCoordinates({ latitude: latNum, longitude: lngNum });
                                    setGpsError(null);
                                    setShowManualCoordinates(false);
                                  }
                                }}
                                className="bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs py-1.5 px-3 rounded-lg transition-colors cursor-pointer w-full"
                              >
                                Apply Custom Coordinates
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex gap-4">
                          <button
                            onClick={handleRetake}
                            className="flex-1 border border-slate-300 hover:bg-slate-50 font-bold py-3 px-4 rounded-full text-slate-700 text-sm transition-colors cursor-pointer"
                          >
                            Retake Snapshot
                          </button>
                          <button
                            onClick={submitDamageReport}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-4 rounded-full text-sm transition-colors shadow-md hover:shadow-lg flex items-center justify-center gap-2 cursor-pointer"
                          >
                            <ShieldAlert className="w-4 h-4" />
                            Analyze &amp; Register Sign
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        {isCameraActive ? (
                          <div className="p-4 bg-slate-900">
                            <div className="relative rounded-2xl overflow-hidden bg-black aspect-video max-h-96 flex items-center justify-center border border-slate-800">
                              <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                className="w-full h-full object-cover"
                              ></video>

                              <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-sm text-white py-1 px-3 rounded-full text-xxs font-bold uppercase tracking-wider flex items-center gap-1.5">
                                <div className="w-2 h-2 bg-red-500 rounded-full animate-ping"></div>
                                Live Camera Stream
                              </div>

                              <div className="absolute bottom-5 left-1/2 transform -translate-x-1/2 flex flex-col items-center gap-1">
                                <button
                                  onClick={capturePhoto}
                                  className="w-14 h-14 bg-white hover:bg-slate-100 rounded-full border-4 border-slate-400/50 hover:border-slate-300/80 cursor-pointer shadow-lg active:scale-95 transition-all flex items-center justify-center"
                                  title="Take Photo"
                                >
                                  <div className="w-8 h-8 bg-emerald-600 rounded-full"></div>
                                </button>
                                <span className="text-[10px] font-black text-white bg-black/60 px-2 py-0.5 rounded-full drop-shadow">SNAP PHOTO</span>
                              </div>
                            </div>

                            <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-white/90">
                              <div className="text-xs text-slate-400">
                                Back-facing lens requested automatically
                              </div>
                              <button
                                onClick={() => setIsCameraActive(false)}
                                className="text-xs font-bold text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer flex items-center gap-1"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                Or upload a photo instead
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="p-8 text-center">
                            <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 bg-slate-50 flex flex-col items-center hover:border-emerald-500 transition-colors">
                              <div className="bg-emerald-100 p-4 rounded-full text-emerald-800 mb-4 shadow-inner">
                                <Upload className="w-8 h-8" />
                              </div>
                              <h3 className="font-extrabold text-slate-800 text-base">Upload Road Sign Photo</h3>
                              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                                Select an existing image from your device gallery. We will analyze the visual contents and ask for location coordinates.
                              </p>

                              <label className="mt-5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm py-2 px-6 rounded-full transition-all shadow hover:shadow-md cursor-pointer flex items-center gap-2">
                                Select File
                                <input
                                  type="file"
                                  accept="image/*"
                                  onChange={handleFileChange}
                                  className="hidden"
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <canvas ref={canvasRef} className="hidden"></canvas>
              </div>
            )}

            {/* VIEW: PUBLIC DASHBOARD */}
            {activeTab === 'dashboard' && (
              <div className="space-y-6">
                {/* KPI metrics bar */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
                    <div className="bg-slate-100 p-3 rounded-xl text-slate-600">
                      <Activity className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Total Hazards</span>
                      <span className="text-xl font-extrabold text-slate-900 leading-none mt-1 inline-block">{reportsLoading ? '...' : totalCount}</span>
                    </div>
                  </div>

                  <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
                    <div className="bg-red-100 p-3 rounded-xl text-red-700">
                      <ShieldAlert className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Critical (Lvl 5)</span>
                      <span className="text-xl font-extrabold text-red-600 leading-none mt-1 inline-block">{reportsLoading ? '...' : criticalCount}</span>
                    </div>
                  </div>

                  <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
                    <div className="bg-amber-100 p-3 rounded-xl text-amber-700">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Pending / Not Done</span>
                      <span className="text-xl font-extrabold text-amber-700 leading-none mt-1 inline-block">{reportsLoading ? '...' : pendingCount}</span>
                    </div>
                  </div>

                  <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-3.5">
                    <div className="bg-emerald-100 p-3 rounded-xl text-emerald-800">
                      <CheckCircle className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-[10px] font-black uppercase text-slate-400 block tracking-wider leading-none">Work Done</span>
                      <span className="text-xl font-extrabold text-emerald-800 leading-none mt-1 inline-block">{reportsLoading ? '...' : workDoneCount}</span>
                    </div>
                  </div>
                </div>

                {/* INTERACTIVE GOOGLE MAP SECTION */}
                {renderGoogleMapCard('Public Dashboard — Hazard Location Map')}

                {/* REGISTRY LOGS TABLE */}
                <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="p-6 border-b border-slate-200 space-y-4 md:space-y-0 md:flex md:items-center md:justify-between md:gap-4">
                    <div>
                      <h3 className="font-extrabold text-slate-900 text-base">Public Infrastructure Registry</h3>
                      <p className="text-xs text-slate-500 mt-0.5">Community hazard reports and live municipal repair status</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative">
                        <Search className="w-4 h-4 text-slate-400 absolute top-1/2 left-3 transform -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder="Search sign type, damage..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-9 pr-4 py-1.5 border border-slate-300 rounded-full text-xs w-full sm:w-56 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>

                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as 'all' | ReportStatus)}
                        className="border border-slate-300 rounded-full text-xs px-3 py-1.5 focus:outline-none focus:border-emerald-500 font-bold bg-white"
                      >
                        <option value="all">All Statuses</option>
                        <option value="Pending / Not Done">Pending / Not Done</option>
                        <option value="Work Done">Work Done</option>
                      </select>

                      <select
                        value={severityFilter}
                        onChange={(e) => setSeverityFilter(e.target.value)}
                        className="border border-slate-300 rounded-full text-xs px-3 py-1.5 focus:outline-none focus:border-emerald-500 font-bold bg-white"
                      >
                        <option value="all">All Severities</option>
                        <option value="5">Severity 5 (Critical)</option>
                        <option value="4">Severity 4 (High)</option>
                        <option value="3">Severity 3 (Moderate)</option>
                        <option value="2">Severity 2 (Low)</option>
                        <option value="1">Severity 1 (Minor)</option>
                      </select>
                    </div>
                  </div>

                  {reportsLoading ? (
                    <div className="p-12 text-center flex flex-col items-center">
                      <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                      <p className="text-xs text-slate-400 mt-2.5">Fetching registry logs...</p>
                    </div>
                  ) : listToDisplay.length === 0 ? (
                    <div className="p-12 text-center max-w-sm mx-auto">
                      <div className="bg-slate-100 p-4 rounded-full text-slate-400 w-14 h-14 mx-auto flex items-center justify-center mb-4">
                        <Search className="w-6 h-6" />
                      </div>
                      <h4 className="font-extrabold text-slate-800 text-sm">
                        {reports.length === 0 ? 'No reports submitted yet' : 'No matched reports found'}
                      </h4>
                      <p className="text-xs text-slate-500 mt-1">
                        {reports.length === 0
                          ? 'No road sign damage reports have been registered. Capture or upload a photo to submit the first report.'
                          : 'Try resetting your search query, status filter, or severity filter to view other reports.'}
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-slate-200">
                        <thead className="bg-slate-50">
                          <tr>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sl. No</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sign Preview</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Sign Type</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Damage Description</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Severity</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Status</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Location</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Date Reported</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Reporter</th>
                            <th scope="col" className="px-6 py-3.5 text-left text-xxs font-black text-slate-400 uppercase tracking-wider">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-slate-150 text-slate-700">
                          {listToDisplay.map((report, index) => (
                            <tr key={report.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-4 whitespace-nowrap text-xs font-bold text-slate-500">
                                {index + 1}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <img
                                  src={report.imageUrl}
                                  alt={report.signType}
                                  className="w-12 h-12 object-cover rounded-lg border border-slate-200 shadow-sm"
                                />
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-xs font-extrabold text-slate-900">
                                {report.signType}
                              </td>
                              <td className="px-6 py-4 text-xs font-medium max-w-xs truncate" title={report.damageDescription}>
                                {report.damageDescription}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                {renderSeverityPill(report.severityScore)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                {renderStatusBadge(report.status)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <button
                                  onClick={() => {
                                    setSelectedReportId(report.id);
                                    const mapHeader = document.querySelector('h3');
                                    mapHeader?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  }}
                                  className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline flex items-center gap-1.5 cursor-pointer bg-slate-50 hover:bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200 transition-colors"
                                  title="Click to view pin on map"
                                >
                                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                                  <span className="font-mono">
                                    {Number(report.latitude).toFixed(4)}, {Number(report.longitude).toFixed(4)}
                                  </span>
                                </button>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-500 font-medium">
                                {new Date(report.timestamp).toLocaleDateString()} at {new Date(report.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-xs font-semibold text-slate-700">
                                <div className="flex items-center gap-1.5">
                                  <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-[10px] font-bold uppercase shrink-0">
                                    {(report.userName || 'C').charAt(0)}
                                  </div>
                                  <span className="truncate max-w-[120px]">{report.userName || 'Community Scout'}</span>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-xs">
                                {renderDeleteCell(report)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>
        </>
      )}

      {/* Footer Branding */}
      <footer className="bg-slate-900 text-slate-400 border-t border-slate-800 text-center py-6 mt-12">
        <div className="max-w-7xl mx-auto px-4 text-xs space-y-1.5 font-medium">
          <p>© 2026 SignAlert Infrastructure Monitor. Powered by Gemini AI &amp; Google Maps Platform.</p>
          <p>Please review and harden Firestore Security Rules inside `firestore.rules` before public deployment.</p>
        </div>
      </footer>

      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="bg-slate-900 text-white px-4 py-3 rounded-2xl shadow-xl fixed bottom-6 right-6 z-[2000] flex items-center gap-2.5 text-xs font-bold border border-slate-700 animate-fade-in">
          <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
          <button onClick={() => setToastMessage(null)} className="ml-2 text-slate-400 hover:text-white cursor-pointer">
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
