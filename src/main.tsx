import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Not wrapped in StrictMode: the voice pipeline opens a real WebSocket and
// requests the microphone on mount, and StrictMode's dev-only double-invoke
// of effects would connect/disconnect/reconnect it every load.
createRoot(document.getElementById("root")!).render(<App />);
