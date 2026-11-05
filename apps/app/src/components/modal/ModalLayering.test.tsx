// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  openCoreModal,
  registerCoreModal,
  resetModalHostForTest,
} from "@/lib/modal-host";
import { ModalHost } from "./ModalHost";

function ConfirmBody() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Delete</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Delete this?</DialogTitle>
          <DialogDescription>It cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PopoverBody() {
  return (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button>Info</Button>
      </PopoverTrigger>
      <PopoverContent>Popover text</PopoverContent>
    </Popover>
  );
}

function MenuBody() {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button>Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

function escape() {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  registerCoreModal("core/confirm", ConfirmBody);
  registerCoreModal("core/popover", PopoverBody);
  registerCoreModal("core/menu", MenuBody);
});

afterEach(() => {
  cleanup();
  resetModalHostForTest();
});

describe("overlays opened from inside the modal", () => {
  it.each([
    ["Dialog", "core/confirm", "Delete this?"],
    ["Popover", "core/popover", "Popover text"],
    ["DropdownMenu", "core/menu", "Rename"],
  ])(
    "%s sits above the modal and Esc closes only it",
    async (_kind, modalId, innerText) => {
      render(
        <BrowserRouter>
          <ModalHost />
        </BrowserRouter>,
      );
      act(() => openCoreModal(modalId, { title: "Outer" }));
      await settle();
      expect(screen.getByText(innerText)).toBeTruthy();
      const entries = window.history.length;

      escape();
      await settle();

      expect(screen.queryByText(innerText)).toBeNull();
      expect(window.history.state?.usr?.bbModal).toBeDefined();
      expect(screen.getByText("Outer")).toBeTruthy();
      expect(window.history.length).toBe(entries);

      escape();
      await settle();
      expect(window.history.state?.usr?.bbModal).toBeUndefined();
    },
  );
});
