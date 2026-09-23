import type { IScannerControls } from "@zxing/browser";
import { Camera, CameraOff, ScanLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, Notice } from "./Primitives";

export function QrScanner({ label, onResult }: { label: string; onResult: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const deliveredRef = useRef(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"idle" | "starting" | "scanning" | "blocked">("idle");

  useEffect(() => {
    if (!started || !videoRef.current) return;
    let cancelled = false;
    deliveredRef.current = false;
    setStatus("starting");
    void (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (cancelled || !videoRef.current) return;
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 220, delayBetweenScanSuccess: 900 });
        const controls = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" } } },
          videoRef.current,
          (result) => {
            if (!result || deliveredRef.current || cancelled) return;
            deliveredRef.current = true;
            controlsRef.current?.stop();
            setStarted(false);
            setStatus("idle");
            onResult(result.getText());
          },
        );
        if (cancelled) return controls.stop();
        controlsRef.current = controls;
        setStatus("scanning");
      } catch {
        if (cancelled) return;
        setStarted(false);
        setStatus("blocked");
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onResult, started]);

  if (!started) {
    return (
      <div className="scanner-placeholder">
        <ScanLine size={30} aria-hidden="true" />
        <strong>{label}</strong>
        <p>The camera opens only when you choose it. Pasting works too.</p>
        <Button icon={Camera} variant="secondary" onClick={() => setStarted(true)}>Start camera</Button>
        {status === "blocked" ? <Notice tone="recoverable" title="Camera unavailable">Paste the request below. No ecash was changed.</Notice> : null}
      </div>
    );
  }

  return (
    <div className="scanner" aria-busy={status === "starting" || undefined}>
      <video ref={videoRef} muted playsInline aria-label={label} />
      <div className="scanner__frame" aria-hidden="true" />
      <span className="scanner__status" role="status">{status === "starting" ? "Starting camera..." : "Looking for a QR code"}</span>
      <button
        type="button"
        className="scanner__stop"
        aria-label="Stop camera"
        title="Stop camera"
        onClick={() => {
          controlsRef.current?.stop();
          controlsRef.current = null;
          setStarted(false);
          setStatus("idle");
        }}
      >
        <CameraOff size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
