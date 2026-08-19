export interface BuildWorkbenchOptions {
  globalRoot?: string;
  sourceRoot?: string;
  compile?(outputRoot: string, sourceRoot: string): Promise<void>;
  validate?(runtimeRoot: string): Promise<void>;
  installLauncher?(launcher: string, entry: string): Promise<void>;
}

export interface BuildWorkbenchResult {
  globalRoot: string;
  cacheRoot: string;
  current: string;
  launcher: string;
}

export function buildWorkbench(options?: BuildWorkbenchOptions): Promise<BuildWorkbenchResult>;
