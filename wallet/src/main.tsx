import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/public-sans/latin-400.css";
import "@fontsource/public-sans/latin-600.css";
import "@fontsource/public-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";

import App from "./App";
import { WalletErrorBoundary } from "./components/WalletErrorBoundary";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletErrorBoundary>
      <App />
    </WalletErrorBoundary>
  </React.StrictMode>,
);
