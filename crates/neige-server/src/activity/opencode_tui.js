// neige-activity — managed by `neige-server hooks install`
// Installed as tui.js beside the v1 reporter's index.js in the v2 package.
import { createEffect, createRoot } from "solid-js";
import { NeigeActivityPlugin } from "./index.js";

export default {
  id: "neige-activity",
  async setup(ctx) {
    const noop = async () => {};
    if (!process.env.NEIGE_SESSION_ID || !process.env.NEIGE_SERVER_URL) return noop;
    const hooks = await NeigeActivityPlugin();
    let stopped = false;
    let pending = null;
    let sending = false;
    let drained = Promise.resolve();
    let stopEffect = noop;

    // A slow POST must not reorder snapshots or queue every intermediate
    // render. Keep only the latest reading behind the in-flight request.
    function publish(event) {
      pending = event;
      if (sending) return;
      sending = true;
      drained = (async () => {
        try {
          while (pending && !stopped) {
            const event = pending;
            pending = null;
            await hooks.event({ event });
          }
        } finally {
          sending = false;
        }
      })();
    }

    try {
      stopEffect = createRoot((dispose) => {
        createEffect(() => {
          try {
            const route = ctx.ui.router.current();
            const sessions = ctx.data.session;
            const root = route.type === "session" ? sessions.root(route.sessionID) : null;
            const family = root ? [...new Set([root, ...sessions.family(root)])] : [];
            // Read all statuses so Solid tracks children even when a root
            // is already busy; no events from other terminals enter this set.
            const readings = family.map((id) => ({
              running: sessions.status(id) === "running",
              waiting: (sessions.permission.list(id)?.length ?? 0) > 0 ||
                (sessions.form.list(id)?.length ?? 0) > 0,
            }));
            if (readings.some((reading) => reading.waiting)) {
              publish({ type: "permission.asked" });
              return;
            }
            publish({
              type: "session.status",
              properties: { sessionID: "tui", status: {
                type: readings.some((reading) => reading.running) ? "busy" : "idle",
              } },
            });
          } catch (err) {
            console.error("neige-activity:", err?.message ?? err);
          }
        });
        return dispose;
      });
    } catch (err) {
      console.error("neige-activity:", err?.message ?? err);
    }
    return async () => {
      stopped = true;
      pending = null;
      stopEffect();
      await drained;
    };
  },
};
