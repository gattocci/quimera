import "@chimera/ui/styles.css";
import "./quimera.css";
import { initChimera } from "@chimera/wasm/chimera.ts";

const root = document.getElementById("root")!;

async function boot() {
  try {
    // The upstream UI modules call the engine while they load, so initialize WASM first.
    await initChimera();
    const { SceneApp } = await import("./SceneApp.tsx");
    const { createRoot } = await import("react-dom/client");
    createRoot(root).render(<SceneApp />);
  } catch (error) {
    root.replaceChildren();
    const message = document.createElement("p");
    message.className = "quimera-error";
    message.textContent = `No se pudo cargar CHIMERA: ${error instanceof Error ? error.message : String(error)}`;
    root.append(message);
  }
}

void boot();
