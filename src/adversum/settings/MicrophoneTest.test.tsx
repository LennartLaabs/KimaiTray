// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  startVoiceTest: vi.fn(),
  finishVoiceTest: vi.fn(),
  cancelVoice: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../voice/voiceApi", async (original) => ({
  ...(await original<typeof import("../voice/voiceApi")>()),
  startVoiceTest: mocks.startVoiceTest,
  finishVoiceTest: mocks.finishVoiceTest,
  cancelVoice: mocks.cancelVoice,
}));

import { VOICE_LEVEL_EVENT, type VoiceTestResult } from "../voice/voiceApi";
import MicrophoneTest, { TEST_SECONDS } from "./MicrophoneTest";

const result: VoiceTestResult = {
  outcome: "ok",
  text: "DUSW Projektmanagement",
  detail: null,
  info: { device: "Trust USB microphone", sampleRate: 48000, channels: 2, sampleFormat: "f32" },
  report: {
    seconds: 3.24,
    channelRms: [0.0312, 0.0001],
    channelPeak: [0.41],
    usedChannel: 0,
    offset: 0.002,
    noiseFloor: 0.0004,
    speechLevel: 0.052,
    hasSpeech: true,
    gain: 1.2,
    rms: 0.04,
    peak: 0.5,
  },
  rawPath: "/Users/l/voice-debug/last-raw.wav",
  preparedPath: "/Users/l/voice-debug/last-16k.wav",
};

let levelHandler: (event: { payload: number }) => void;

async function settle() {
  await act(async () => undefined);
}

async function startTest() {
  fireEvent.click(screen.getByRole("button", { name: "adversum.voice.test.start" }));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(async (_event: string, handler: (event: { payload: number }) => void) => {
    levelHandler = handler;
    return vi.fn();
  });
  mocks.startVoiceTest.mockResolvedValue(undefined);
  mocks.finishVoiceTest.mockResolvedValue(result);
  mocks.cancelVoice.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MicrophoneTest", () => {
  it("records with a live level, then shows what was understood and measured", async () => {
    const { container } = render(<MicrophoneTest />);
    expect(mocks.listen).toHaveBeenCalledWith(VOICE_LEVEL_EVENT, expect.any(Function));
    expect(screen.queryByRole("meter")).toBeNull();
    await startTest();
    expect(container.querySelector("[data-voice-test='recording']")).not.toBeNull();

    act(() => levelHandler({ payload: 0.42 }));
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("42");
    act(() => levelHandler({ payload: 3 }));
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("100");

    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.test.stop" }));
    expect(screen.getByRole("button", { name: "adversum.voice.transcribing" })).toHaveProperty(
      "disabled",
      true,
    );
    await settle();
    expect(container.querySelector("[data-voice-test-result='ok']")).not.toBeNull();
    expect(screen.getByText("adversum.voice.test.heard:DUSW Projektmanagement")).toBeTruthy();
    expect(
      screen.getByText("adversum.voice.test.device:Trust USB microphone,48000,2,f32,3.2"),
    ).toBeTruthy();
    // A missing peak value is shown as zero.
    expect(
      screen.getByText("adversum.voice.test.levels:0.0312 / 0.4100 · 0.0001 / 0.0000,1"),
    ).toBeTruthy();
    expect(screen.getByText("adversum.voice.test.speech:0.0004,0.0520,1.2")).toBeTruthy();
    expect(screen.getByText("adversum.voice.test.saved:/Users/l/voice-debug/last-raw.wav")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();

    // A new test clears the old result.
    await startTest();
    expect(container.querySelector("[data-voice-test-result]")).toBeNull();
  });

  it("ends by itself after a few seconds", async () => {
    vi.useFakeTimers();
    render(<MicrophoneTest />);
    await startTest();
    act(() => void vi.advanceTimersByTime(TEST_SECONDS * 1000 - 1));
    expect(mocks.finishVoiceTest).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(mocks.finishVoiceTest).toHaveBeenCalledTimes(1);
    await settle();
  });

  it("says why a recording came to nothing, with the concrete error", async () => {
    mocks.finishVoiceTest.mockResolvedValue({
      ...result,
      outcome: "tooQuiet",
      text: "",
      rawPath: null,
    });
    const { container } = render(<MicrophoneTest />);
    await startTest();
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.test.stop" }));
    await settle();
    expect(container.querySelector("[data-voice-test-result='tooQuiet']")).not.toBeNull();
    expect(screen.getByText("adversum.voice.problem.tooQuiet")).toBeTruthy();
    expect(screen.queryByText(/adversum\.voice\.test\.saved/)).toBeNull();

    mocks.finishVoiceTest.mockResolvedValue({
      ...result,
      outcome: "failed",
      text: "",
      detail: "Whisper: error -6",
    });
    await startTest();
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.test.stop" }));
    await settle();
    expect(screen.getByText("Whisper: error -6")).toBeTruthy();
  });

  it("reports why the test could not start or finish", async () => {
    mocks.startVoiceTest.mockRejectedValueOnce("permissionDenied");
    render(<MicrophoneTest />);
    await startTest();
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.permissionDenied");
    expect(screen.queryByRole("meter")).toBeNull();

    // An unknown problem is shown as it is.
    mocks.startVoiceTest.mockRejectedValueOnce("The device is in use");
    await startTest();
    expect(screen.getByRole("alert").textContent).toBe("The device is in use");

    mocks.finishVoiceTest.mockRejectedValueOnce("notTesting");
    await startTest();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.test.stop" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("notTesting");
  });

  it("ends a running test when the page is left, and survives a window without events", async () => {
    mocks.cancelVoice.mockRejectedValue(new Error("gone"));
    const running = render(<MicrophoneTest />);
    await startTest();
    running.unmount();
    expect(mocks.cancelVoice).toHaveBeenCalledTimes(1);

    mocks.listen.mockRejectedValue(new Error("no events"));
    const idle = render(<MicrophoneTest />);
    await settle();
    expect(() => idle.unmount()).not.toThrow();
    expect(mocks.cancelVoice).toHaveBeenCalledTimes(1);
  });
});
