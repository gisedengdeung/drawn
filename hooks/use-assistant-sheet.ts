'use client';

import { useSyncExternalStore } from 'react';

const query = '(max-width: 1023px)';
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const getSnapshot = () => window.matchMedia(query).matches;
const getServerSnapshot = () => false;

export function useAssistantSheet() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
