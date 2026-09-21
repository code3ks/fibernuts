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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!started || !videoRef.current) return;
    let cancelled = false;
    deliveredRef.current = false;
    setStatus("starting");
    setError(null);

    void (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (cancelled || !videoRef.current) return;
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 200, delayBetweenScanSuccess: 800 });
        const controls = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        videoRef.current,
        (result) => {
          if (!result || deliveredRef.current || cancelled) return;
          deliveredRef.current = true;
          controlsRef.current?.stop();
          setStatus("idle");
          setStarted(false);
          onResult(result.getText());
        },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setStatus("scanning");
      } catch (reason) {
        if (cancelled) return;
        setStatus("blocked");
        setError(reason instanceof Error ? reason.message : "Camera access was not available.");
        setStarted(false);
      }
    })();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [onResult, started]);

  const stop = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setStarted(false);
    setStatus("idle");
  };

  if (!started) {
    return (
      <div className="scanner-placeholder">
        <ScanLine size={30} aria-hidden="true" />
        <strong>{label}</strong>
        <p>The camera starts only after you choose to scan. You can always paste the code instead.</p>
        <Button icon={Camera} onClick={() => setStarted(true)}>
          Start camera
        </Button>
        {status === "blocked" && error ? (
          <Notice tone="recoverable" title="Camera unavailable">
            Paste the code below. No wallet data was changed.
          </Notice>
        ) : null}
      </div>
    );
  }

  return (
    <div className="scanner" aria-busy={status === "starting" || undefined}>
      <video ref={videoRef} className="scanner__video" muted playsInline aria-label={label} />
      <div className="scanner__frame" aria-hidden="true" />
      <div className="scanner__status" role="status">
        {status === "starting" ? "Starting camera..." : "Looking for a QR code"}
      </div>
      <button type="button" className="scanner__stop" onClick={stop} aria-label="Stop camera" title="Stop camera">
        <CameraOff size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
