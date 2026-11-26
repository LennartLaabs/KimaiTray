// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ label: "adversum-quick", render: vi.fn() }));

vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: mocks.render }) },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.label }) }));
vi.mock("../shared/i18n", () => ({ initPromise: Promise.resolve() }));
vi.mock("../platform", () => ({
  getPlatformInfo: async () => ({
    os: "macos", session: "native", trayBackend: "native", supportsNativePopupCorners: true,
  }),
}));
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../providers/QueryProvider", () => ({ default: ({ children }: any) => children }));
vi.mock("../components/GlobalContextMenuGuard", () => ({ default: () => null }));
vi.mock("../windows/TrayPopup", () => ({ default: () => <div>tray-window</div> }));
vi.mock("../windows/Settings", () => ({ default: () => <div>settings-window</div> }));
vi.mock("./quickEntry/QuickEntryWindow", () => ({ default: () => <div>quick-window</div> }));
vi.mock("./AdversumBridge", () => ({ default: () => null }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});

/** The children of the query provider that `main.tsx` renders. */
async function providerChildren(label: string): Promise<any[]> {
  mocks.label = label;
  await import("../main");
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalled());
  const tree = mocks.render.mock.calls[0]![0];
  return tree.props.children.props.children.props.children;
}

describe("window routing for the fork", () => {
  it("renders the quick entry window with the display bridge next to it", async () => {
    const children = await providerChildren("adversum-quick");
    const windowElement = children[children.length - 1];
    expect(windowElement.type().props.children).toBe("quick-window");
    expect(children[1].props.windowLabel).toBe("adversum-quick");
  });

  it("gives the tray popup a bridge, but not the settings window", async () => {
    const tray = await providerChildren("tray-popup");
    expect(tray[1].props.windowLabel).toBe("tray-popup");
    vi.resetModules();
    mocks.render.mockClear();
    const settings = await providerChildren("settings");
    expect(settings[1]).toBe(false);
    expect(settings[settings.length - 1].type().props.children).toBe("settings-window");
  });
});
