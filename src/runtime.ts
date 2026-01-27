let runtimeRef: any = null;

export function setDingTalkRuntime(runtime: any) {
  runtimeRef = runtime;
}

export function getDingTalkRuntime(): any {
  if (!runtimeRef) throw new Error("DingTalk runtime not initialized");
  return runtimeRef;
}
