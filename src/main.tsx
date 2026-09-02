import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./ui/AppShell";
import { LibraryScreen } from "./ui/LibraryScreen";
import { WorkScreen } from "./ui/WorkScreen";
import { NameScreen } from "./ui/NameScreen";
import { PlayerScreen } from "./ui/PlayerScreen";
import { TransferScreen } from "./ui/TransferScreen";
import { SettingsScreen } from "./ui/SettingsScreen";
import { DiagnosticsScreen } from "./ui/DiagnosticsScreen";
import { OpenScreen } from "./ui/OpenScreen";
import { MobileImportScreen } from "./ui/MobileImportScreen";
import { AfurecoScreen } from "./ui/AfurecoScreen";
import { AfurecoProjectScreen } from "./ui/AfurecoProjectScreen";
import { AuthoringScreen } from "./ui/AuthoringScreen";
import { NotFoundScreen } from "./ui/NotFoundScreen";
import { WorksProvider } from "./ui/works-context";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/", element: <AppShell />, children: [
      { index: true, element: <LibraryScreen /> },
      { path: "library", element: <LibraryScreen /> },
      { path: "open/:workId", element: <OpenScreen /> },
      { path: "works/:workId/:version", element: <WorkScreen /> },
      { path: "works/:workId/:version/name", element: <NameScreen /> },
      { path: "works/:workId/:version/transfer", element: <TransferScreen /> },
      { path: "afureco", element: <AfurecoScreen /> },
      { path: "afureco/projects/:projectId", element: <AfurecoProjectScreen /> },
      { path: "settings", element: <SettingsScreen /> },
      { path: "diagnostics", element: <DiagnosticsScreen /> },
      { path: "authoring", element: <AuthoringScreen /> },
      { path: "*", element: <NotFoundScreen /> }
    ]
  },
  { path: "/play/:workId/:version", element: <PlayerScreen /> },
  { path: "/mobile-import", element: <MobileImportScreen /> }
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><WorksProvider><RouterProvider router={router} /></WorksProvider></React.StrictMode>
);
