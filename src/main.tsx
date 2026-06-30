// SPA entry point (replaces Next.js app/layout.tsx + the App Router).
// Tiny path-based router: the only non-root page is the static /privacy policy.

import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import Home from "@/app/page";
import PrivacyPage from "@/app/privacy/page";

const isPrivacy = window.location.pathname.replace(/\/+$/, "") === "/privacy";
const Page = isPrivacy ? PrivacyPage : Home;

createRoot(document.getElementById("root")!).render(<Page />);
