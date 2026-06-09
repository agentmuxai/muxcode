import { execSync } from 'child_process';

export type OsPlatform = 'macos' | 'win' | 'ubuntu';
export type Arch = 'arm64' | 'x64';
export type Gpu = 'metal' | 'cuda' | 'cpu';

export interface Platform {
  os: OsPlatform;
  arch: Arch;
  gpu: Gpu;
}

export function detectPlatform(): Platform {
  const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  if (process.platform === 'darwin') {
    // macOS arm64 uses Metal via system framework (no separate GPU binary needed)
    return { os: 'macos', arch, gpu: arch === 'arm64' ? 'metal' : 'cpu' };
  }

  if (process.platform === 'win32') {
    return { os: 'win', arch: 'x64', gpu: checkCuda() ? 'cuda' : 'cpu' };
  }

  // Linux
  return { os: 'ubuntu', arch, gpu: checkCuda() ? 'cuda' : 'cpu' };
}

function checkCuda(): boolean {
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      stdio: 'pipe',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function assetName(build: string, platform: Platform): string {
  if (platform.gpu === 'cuda') {
    // CUDA assets use a different naming pattern
    return `llama-${build}-bin-${platform.os}-cuda-${platform.arch}.tar.gz`;
  }
  return `llama-${build}-bin-${platform.os}-${platform.arch}.tar.gz`;
}

export const APPROX_SIZES: Record<string, string> = {
  'macos-arm64': '~25 MB',
  'macos-x64':   '~22 MB',
  'ubuntu-x64':  '~20 MB',
  'ubuntu-arm64':'~18 MB',
  'win-x64':     '~28 MB',
  'win-x64-cuda':'~373 MB',
};

export function platformKey(p: Platform): string {
  return `${p.os}-${p.arch}${p.gpu === 'cuda' ? '-cuda' : ''}`;
}
