import { useCallback, useState } from "react";
import { api } from "../lib/api.js";

export function useClipLibrary(onUnauthorized, notify) {
  const [clips, setClips] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingClips, setLoadingClips] = useState(false);

  const loadClips = useCallback(async (reset = true) => {
    setLoadingClips(true);
    try {
      const params = new URLSearchParams({ limit: "24" });
      if (!reset && cursor) params.set("cursor", cursor);
      const result = await api(`/api/clips?${params}`);
      setClips((previous) => reset ? result.clips : [...previous, ...result.clips]);
      setCursor(result.nextCursor);
    } catch (error) {
      if (error.status === 401) onUnauthorized();
      else notify(error.message);
    } finally {
      setLoadingClips(false);
    }
  }, [cursor, notify, onUnauthorized]);

  const removeClip = useCallback((clipId) => {
    setClips((items) => items.filter((item) => item.id !== clipId));
  }, []);

  return { clips, setClips, cursor, loadingClips, loadClips, removeClip };
}
