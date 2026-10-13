import * as os from "os";
import * as path from "path";

/**
 * Plugin cache files live under the OpenClaw state dir, not the plugin's install
 * directory: OpenClaw 10.x manages `<state>/extensions/` and scans it for plugins,
 * and linked installs keep the checkout elsewhere entirely.
 */
export function resolveDingTalkCacheFile(name: string): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "dingtalk-cache", name);
}
