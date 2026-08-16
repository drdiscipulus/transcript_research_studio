import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorPlaybackState, EditorPlayRequest } from "../lib/editorContracts";

type EditorMediaPlayerProps = {
  mediaPath: string;
  mediaUrl: string;
  playRequest: EditorPlayRequest | null;
  onPlaybackStateChange?: (state: EditorPlaybackState) => void;
  compact?: boolean;
};

type ActiveMediaRequest = {
  request: EditorPlayRequest;
  media: HTMLAudioElement | HTMLVideoElement;
  source: string;
};

const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"]);

function fileExtension(path: string): string {
  const match = path.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

export function EditorMediaPlayer({
  mediaPath,
  mediaUrl,
  playRequest,
  onPlaybackStateChange,
  compact = false
}: EditorMediaPlayerProps) {
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const activeRequestRef = useRef<ActiveMediaRequest | null>(null);
  const playRequestRef = useRef(playRequest);
  const sourceRef = useRef(mediaUrl);
  const playbackCallbackRef = useRef(onPlaybackStateChange);
  const mountedRef = useRef(false);
  const [waveformStatus, setWaveformStatus] = useState<"idle" | "ready" | "unavailable">("idle");
  const extension = fileExtension(mediaPath);
  const isVideo = videoExtensions.has(extension);
  const canUseWaveform = Boolean(mediaUrl && !isVideo);

  if (sourceRef.current !== mediaUrl) {
    sourceRef.current = mediaUrl;
    activeRequestRef.current = null;
  }
  playRequestRef.current = playRequest;
  playbackCallbackRef.current = onPlaybackStateChange;

  const setMediaNode = useCallback((node: HTMLAudioElement | HTMLVideoElement | null) => {
    if (mediaRef.current !== node) {
      activeRequestRef.current = null;
    }
    mediaRef.current = node;
  }, []);

  const requestIsCurrent = useCallback((active: ActiveMediaRequest, requireActive = true) => (
    mountedRef.current
    && mediaRef.current === active.media
    && sourceRef.current === active.source
    && playRequestRef.current?.id === active.request.id
    && (!requireActive || activeRequestRef.current === active)
  ), []);

  const publishPlaybackState = useCallback((
    active: ActiveMediaRequest,
    status: NonNullable<EditorPlaybackState>["status"],
    requireActive = true
  ) => {
    if (!requestIsCurrent(active, requireActive)) {
      return;
    }
    playbackCallbackRef.current?.({
      requestId: active.request.id,
      segmentId: active.request.segmentId,
      status
    });
  }, [requestIsCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !playRequest) {
      return;
    }
    const previous = activeRequestRef.current;
    const source = sourceRef.current;
    const isSameSegment = previous?.media === media
      && previous.source === source
      && previous.request.segmentId === playRequest.segmentId;
    const active = { request: playRequest, media, source };

    if (playRequest.action === "stop") {
      activeRequestRef.current = null;
      media.pause();
      media.currentTime = Math.max(0, playRequest.start);
      publishPlaybackState(active, "stopped", false);
      return;
    }

    activeRequestRef.current = active;

    if (isSameSegment && !media.paused && media.currentTime >= playRequest.start && media.currentTime <= playRequest.end) {
      media.pause();
      publishPlaybackState(active, "paused");
      return;
    }

    if (!isSameSegment || media.currentTime < playRequest.start || media.currentTime >= playRequest.end) {
      media.currentTime = Math.max(0, playRequest.start);
    }
    void media.play()
      .then(() => publishPlaybackState(active, "playing"))
      .catch(() => publishPlaybackState(active, "paused"));
  }, [playRequest, publishPlaybackState]);

  useEffect(() => {
    const media = mediaRef.current;
    const active = activeRequestRef.current;
    if (!media || !playRequest || !active || active.request.id !== playRequest.id) {
      return;
    }
    const mediaElement = media;
    const activeRequest = active;

    function stopAtSegmentEnd() {
      if (!requestIsCurrent(activeRequest)) {
        return;
      }
      if (mediaElement.currentTime >= activeRequest.request.end) {
        activeRequestRef.current = null;
        mediaElement.pause();
        mediaElement.currentTime = activeRequest.request.end;
        publishPlaybackState(activeRequest, "stopped", false);
      }
    }

    function updatePlaying() {
      publishPlaybackState(activeRequest, "playing");
    }

    function updatePaused() {
      if (mediaElement.currentTime < activeRequest.request.end) {
        publishPlaybackState(activeRequest, "paused");
      }
    }

    mediaElement.addEventListener("timeupdate", stopAtSegmentEnd);
    mediaElement.addEventListener("play", updatePlaying);
    mediaElement.addEventListener("pause", updatePaused);
    return () => {
      mediaElement.removeEventListener("timeupdate", stopAtSegmentEnd);
      mediaElement.removeEventListener("play", updatePlaying);
      mediaElement.removeEventListener("pause", updatePaused);
    };
  }, [mediaUrl, playRequest, publishPlaybackState, requestIsCurrent]);

  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      activeRequestRef.current = null;
      if (media && !media.paused) {
        media.pause();
      }
    };
  }, [mediaUrl]);

  useEffect(() => {
    if (!canUseWaveform || !waveformRef.current) {
      setWaveformStatus(mediaUrl ? "unavailable" : "idle");
      return;
    }

    let disposed = false;
    let wavesurfer: { destroy: () => void } | null = null;
    setWaveformStatus("idle");

    void import("wavesurfer.js")
      .then((module) => {
        if (disposed || !waveformRef.current) {
          return;
        }
        wavesurfer = module.default.create({
          container: waveformRef.current,
          height: 72,
          waveColor: "#9ca3af",
          progressColor: "#2563eb",
          cursorColor: "#111827",
          barWidth: 2,
          barGap: 2,
          url: mediaUrl,
          media: mediaRef.current as HTMLAudioElement
        });
        setWaveformStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          setWaveformStatus("unavailable");
        }
      });

    return () => {
      disposed = true;
      wavesurfer?.destroy();
    };
  }, [canUseWaveform, mediaUrl]);

  const fileName = useMemo(() => {
    const normalized = mediaPath.replace(/\\/g, "/");
    return normalized.split("/").pop() ?? mediaPath;
  }, [mediaPath]);

  if (!mediaUrl) {
    return (
      <section className={compact ? "section-card editor-media-panel compact empty" : "section-card editor-media-panel empty"}>
        <div className="section-heading">
          <div>
            <h3 className="home-section-title">Media</h3>
            <p title="Segment playback needs linked media and start/end timestamps. You can still edit transcripts without media.">
              Load the matching audio or video file to play individual timestamped segments.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={compact ? "section-card editor-media-panel compact" : "section-card editor-media-panel"}>
      <div className="section-heading editor-media-header">
        <div>
          <h3 className="home-section-title">Media</h3>
          <p title="Segment playback needs start and end timestamps. Segments without timestamps can still be edited, but their Play button is disabled.">
            {fileName}
          </p>
        </div>
      </div>
      {isVideo ? (
        <video ref={setMediaNode} src={mediaUrl} controls className="editor-video" />
      ) : (
        <>
          <audio ref={setMediaNode} src={mediaUrl} controls className="editor-audio" />
          <div ref={waveformRef} className="editor-waveform" aria-hidden="true" />
          {waveformStatus === "unavailable" ? (
            <small className="editor-muted">Waveform unavailable; native audio controls are active.</small>
          ) : null}
        </>
      )}
    </section>
  );
}
