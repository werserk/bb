import { useSyncExternalStore } from "react";
import type {
  ExperimentalModalHandle,
  ExperimentalModalOpenOptions,
} from "../app-contract.js";

export interface ModalDriver {
  open(
    pluginId: string | null,
    modalId: string,
    options: ExperimentalModalOpenOptions,
  ): void;
  close(): void;
  subscribe(listener: () => void): () => void;
  getOpenId(pluginId: string | null): string | null;
}

const noHostDriver: ModalDriver = {
  open() {
    throw new Error("experimental_modal: this host has no modal host");
  },
  close() {},
  subscribe: () => () => {},
  getOpenId: () => null,
};

let driver: ModalDriver = noHostDriver;

export function installModalDriver(next: ModalDriver): void {
  driver = next;
}

export function createModalHandle(
  pluginId: string | null,
  registeredIds: ReadonlySet<string>,
): ExperimentalModalHandle {
  return {
    open(modalId, options) {
      if (!registeredIds.has(modalId)) {
        throw new Error(
          `slots.experimental_modal: "${modalId}" is not a modal this plugin registered`,
        );
      }
      driver.open(pluginId, modalId, options);
    },
    close() {
      driver.close();
    },
    useOpenId() {
      return useSyncExternalStore(
        driver.subscribe,
        () => driver.getOpenId(pluginId),
        () => null,
      );
    },
  };
}
