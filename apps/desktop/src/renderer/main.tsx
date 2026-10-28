import { StrictMode } from "react";
import "./desktop-api";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./router";
import "./styles/global.css";
import "./components/components.css";

const container = document.getElementById("app");
if (!container) {
  throw new Error("缺少 #app 挂载节点");
}

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
