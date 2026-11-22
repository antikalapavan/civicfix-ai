import { Capacitor } from '@capacitor/core';

const ANDROID_API_BASE_URL = 'https://civicfix-ai-pbcf.onrender.com';

export function getApiUrl(path: string): string {
  if (Capacitor.getPlatform() === 'android') {
    return `${ANDROID_API_BASE_URL}${path}`;
  }

  return path;
}
