import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-jp";
import "./styles.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
