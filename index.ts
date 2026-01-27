import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import { dingtalkPlugin } from "./src/channel.js";
import { setDingTalkRuntime } from "./src/runtime.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin (Stream Mode)",
  configSchema: emptyPluginConfigSchema(),
  register(api: any) {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
