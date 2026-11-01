import { uiProps } from "./ui/props";
import { workbench } from "./ui/workbench";
import { memory, persist } from "./workspace";
import React, { createContext, useContext, useState } from "react";

const Sidebar = createContext({ width: 270, resize: (_width: number) => {} });
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(() => memory.sidebarWidth ?? 270);
  const resize = (value: number) => {
    const next = Math.max(190, Math.min(380, Math.round(value)));
    setWidth(next);
    memory.sidebarWidth = next;
    void persist();
  };
  return <Sidebar.Provider value={{ width, resize }}><div {...uiProps("sidebar-layout", workbench.sidebarLayout(width))}>{children}</div></Sidebar.Provider>;
}
export function SidebarResize() {
  const { width, resize } = useContext(Sidebar);
  return <div {...uiProps("sidebar-resize", workbench.sidebarResize)} role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={190} aria-valuemax={380} aria-valuenow={width} tabIndex={0}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      resize(event.key === "Home" ? 190 : event.key === "End" ? 380 : width + (event.key === "ArrowRight" ? 10 : -10));
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left);
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} />;
}
