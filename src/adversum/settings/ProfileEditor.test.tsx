// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";

const mocks = vi.hoisted(() => ({
  loadEntity: vi.fn(),
  readProfile: vi.fn(),
  saveProfile: vi.fn(),
  startVoiceTest: vi.fn(),
  finishVoiceTest: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../profile/profileApi", () => ({
  loadEntity: mocks.loadEntity,
  readProfile: mocks.readProfile,
  saveProfile: mocks.saveProfile,
}));
vi.mock("../voice/voiceApi", () => ({
  startVoiceTest: mocks.startVoiceTest,
  finishVoiceTest: mocks.finishVoiceTest,
}));

import { readProfileSentence } from "../profile/profileSentence";
import ProfileEditor from "./ProfileEditor";

const client = {} as KimaiClient;
const onSaved = vi.fn();
const SENTENCE = "Ansprechpartner Sepp Huber, intern sagen wir Huber, wir machen Website";

function show(comment: string | null, kind: "customers" | "projects" = "customers") {
  return render(
    <ProfileEditor
      client={client}
      kind={kind}
      entity={{ id: 3, name: "Bäckerei Huber GmbH", comment }}
      onSaved={onSaved}
    />,
  );
}

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(`adversum.profile.${name}`) as HTMLInputElement;
}

function status(): string | null {
  return document.querySelector("[data-profile-status]")!.getAttribute("data-profile-status");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEntity.mockResolvedValue({ name: "Bäckerei Huber GmbH", comment: null, contact: null, homepage: null });
  mocks.readProfile.mockImplementation(async (sentence: string) => readProfileSentence(sentence));
  mocks.saveProfile.mockResolvedValue("");
  mocks.startVoiceTest.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("the profile form", () => {
  it("shows the profile from the description and saves what was changed", async () => {
    show("Hinweis\nAliasse: Huber\nKontakte: Sepp (Seppi)\nThemen: Website");
    expect(field("aliases").value).toBe("Huber");
    expect(field("contacts").value).toBe("Sepp (Seppi)");
    expect(field("topics").value).toBe("Website");
    // A profile that is there needs no proposal.
    expect(mocks.loadEntity).not.toHaveBeenCalled();

    fireEvent.change(field("topics"), { target: { value: "Website, Google Ads" } });
    fireEvent.click(screen.getByText("adversum.profile.save"));
    await waitFor(() => expect(status()).toBe("saved"));
    expect(mocks.saveProfile).toHaveBeenCalledWith(client, "customers", 3, {
      aliases: ["Huber"],
      contacts: [{ name: "Sepp", variants: ["Seppi"] }],
      topics: ["Website", "Google Ads"],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    // Changing something again takes the confirmation away.
    fireEvent.change(field("aliases"), { target: { value: "Huber, BH" } });
    expect(status()).toBe("");
  });

  it("starts a customer nobody described with what Kimai knows", async () => {
    mocks.loadEntity.mockResolvedValue({
      name: "Bäckerei Huber GmbH",
      comment: null,
      contact: "Sepp Huber",
      homepage: "https://huber-backt.de",
    });
    show(null);
    await waitFor(() => expect(field("aliases").value).toBe("Bäckerei Huber, BH, huber-backt"));
    expect(field("contacts").value).toBe("Sepp Huber");
    expect(document.querySelector("[data-profile-suggested]")).not.toBeNull();
    fireEvent.click(screen.getByText("adversum.profile.save"));
    await waitFor(() => expect(status()).toBe("saved"));
    expect(document.querySelector("[data-profile-suggested]")).toBeNull();
  });

  it("proposes nothing when there is nothing, when Kimai fails, or after typing began", async () => {
    // A name that is its own short form, no contact, no homepage.
    mocks.loadEntity.mockResolvedValue({ name: "DUSW", comment: null, contact: null, homepage: null });
    const empty = show(null);
    await act(async () => undefined);
    expect(document.querySelector("[data-profile-suggested]")).toBeNull();
    empty.unmount();

    mocks.loadEntity.mockRejectedValue(new Error("offline"));
    const failing = show(null);
    await act(async () => undefined);
    expect(field("aliases").value).toBe("");
    failing.unmount();

    let answer!: (value: unknown) => void;
    mocks.loadEntity.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const typing = show(null);
    fireEvent.change(field("aliases"), { target: { value: "Selbst" } });
    await act(async () => answer({ name: "Bäckerei Huber GmbH", contact: "Sepp", homepage: null }));
    expect(field("aliases").value).toBe("Selbst");
    typing.unmount();
    // Closed before Kimai answered.
    mocks.loadEntity.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show(null).unmount();
    await act(async () => answer({ name: "Bäckerei Huber GmbH", contact: "Sepp", homepage: null }));
  });

  it("adds what a typed sentence says to what is there", async () => {
    show("Aliasse: BH");
    const sentence = screen.getByLabelText("adversum.profile.sentence") as HTMLInputElement;
    expect((screen.getByText("adversum.profile.apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(sentence, { target: { value: SENTENCE } });
    fireEvent.click(screen.getByText("adversum.profile.apply"));
    await waitFor(() => expect(field("aliases").value).toBe("BH, Huber"));
    expect(field("contacts").value).toBe("Sepp Huber");
    expect(field("topics").value).toBe("Website");
    // Enter does the same; an empty sentence does nothing.
    fireEvent.change(sentence, { target: { value: "Themen Flyer" } });
    fireEvent.keyDown(sentence, { key: "a" });
    fireEvent.keyDown(sentence, { key: "Enter" });
    await waitFor(() => expect(field("topics").value).toBe("Website, Flyer"));
    fireEvent.change(sentence, { target: { value: "  " } });
    fireEvent.keyDown(sentence, { key: "Enter" });
    await act(async () => undefined);
    expect(mocks.readProfile).toHaveBeenCalledTimes(2);
  });

  it("takes a dictated sentence the same way", async () => {
    mocks.finishVoiceTest.mockResolvedValue({ outcome: "ok", text: SENTENCE });
    show(null, "projects");
    // Projects have no contacts.
    expect(screen.queryByLabelText("adversum.profile.contacts")).toBeNull();
    const button = document.querySelector<HTMLButtonElement>("[data-profile-dictate]")!;
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(button.textContent).toBe("adversum.profile.stopDictating");
    // Nothing is saved in the middle of a recording.
    expect((screen.getByText("adversum.profile.save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(field("aliases").value).toBe("Huber"));
    expect((screen.getByLabelText("adversum.profile.sentence") as HTMLInputElement).value).toBe(SENTENCE);
    expect(field("topics").value).toBe("Website");
  });

  it("says when a recording gave nothing or could not start", async () => {
    show("Aliasse: BH");
    const button = document.querySelector<HTMLButtonElement>("[data-profile-dictate]")!;
    mocks.finishVoiceTest.mockResolvedValue({ outcome: "tooQuiet", text: "" });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(button);
    await waitFor(() => expect(status()).toBe("voice"));
    expect(screen.getByText("adversum.profile.problem.voice")).toBeTruthy();

    mocks.finishVoiceTest.mockRejectedValue(new Error("notTesting"));
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(button);
    await waitFor(() => expect(status()).toBe("voice"));

    mocks.startVoiceTest.mockRejectedValue("permissionDenied");
    fireEvent.click(button);
    await waitFor(() => expect(status()).toBe("voice"));
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("says when Kimai does not allow saving, or saving fails", async () => {
    show("Aliasse: BH");
    mocks.saveProfile.mockRejectedValue("forbidden");
    fireEvent.click(screen.getByText("adversum.profile.save"));
    await waitFor(() => expect(status()).toBe("forbidden"));
    expect(screen.getByText("adversum.profile.problem.forbidden")).toBeTruthy();
    mocks.saveProfile.mockRejectedValue("failed");
    fireEvent.click(screen.getByText("adversum.profile.save"));
    await waitFor(() => expect(status()).toBe("failed"));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
