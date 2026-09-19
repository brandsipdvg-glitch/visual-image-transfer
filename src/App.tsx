import { useEffect, useState } from "react";
import { SenderPage } from "./pages/SenderPage";
import { ReceiverPage } from "./pages/ReceiverPage";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Routes() {
  const hash = useHashRoute();
  if (hash.startsWith("#/send")) return <SenderPage />;
  if (hash.startsWith("#/receive")) return <ReceiverPage />;
  return <Home />;
}

function Home() {
  return (
    <main
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 24,
      }}
    >
      <header style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", margin: 0, letterSpacing: "-0.02em" }}>
          Visual Image Transfer
        </h1>
        <p className="muted" style={{ marginTop: 8, maxWidth: 520 }}>
          Send a picture from one screen to another device&apos;s camera.
          Encoded as keyed visual noise — nothing recognizable without the key.
        </p>
      </header>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
        <a href="#/send">
          <button className="primary" style={{ fontSize: "1.05rem", padding: "0.8rem 1.6rem" }}>
            Send an image
          </button>
        </a>
        <a href="#/receive">
          <button style={{ fontSize: "1.05rem", padding: "0.8rem 1.6rem" }}>
            Receive with camera
          </button>
        </a>
      </div>

      <p className="muted mono" style={{ fontSize: "0.8rem", marginTop: 8 }}>
        Rate: device photo → receiver camera, no network
      </p>
    </main>
  );
}

export function App() {
  return <Routes />;
}