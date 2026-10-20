import React from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import App from "./App.jsx";
import { anonymousEvent } from "./analytics.js";
import "./styles.css";

// Opens instantly and offline from the home screen (public/sw.js). Only in
// the built app: in development it would serve stale files.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    {/* Visits and page speed, without cookies; ids and queries stripped (analytics.js). */}
    <Analytics beforeSend={anonymousEvent} />
    <SpeedInsights beforeSend={anonymousEvent} />
  </React.StrictMode>
);
