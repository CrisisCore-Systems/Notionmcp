"use client";

import { useRef, useState } from "react";
import type { Phase } from "./types";

type LastAction = "research" | "write" | null;

export function usePhaseState() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastActionRef = useRef<LastAction>(null);

  const startAction = (action: Exclude<LastAction, null>) => {
    lastActionRef.current = action;
    setErrorMessage(null);
    setPhase(action === "research" ? "researching" : "writing");
  };

  const showApproval = () => {
    setErrorMessage(null);
    setPhase("approving");
  };

  const showDone = () => {
    setErrorMessage(null);
    setPhase("done");
  };

  const showError = (message: string) => {
    setErrorMessage(message);
    setPhase("error");
  };

  return {
    phase,
    setPhase,
    errorMessage,
    setErrorMessage,
    lastActionRef,
    startAction,
    showApproval,
    showDone,
    showError,
  };
}
