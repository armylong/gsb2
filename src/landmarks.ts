import type { LonLat } from './geo';

export interface Landmark {
  id: string;
  name: string;
  ll: LonLat;
}

/** 程序生成场景中仅有的几个地标（无外部地图数据） */
export const LANDMARKS: Landmark[] = [
  { id: 'beijing', name: '北京', ll: { lat: 39.9042, lon: 116.4074 } },
  { id: 'shanghai', name: '上海', ll: { lat: 31.2304, lon: 121.4737 } },
  { id: 'newyork', name: '纽约', ll: { lat: 40.7128, lon: -74.006 } },
  { id: 'losangeles', name: '洛杉矶', ll: { lat: 34.0522, lon: -118.2437 } },
  { id: 'london', name: '伦敦', ll: { lat: 51.5074, lon: -0.1278 } },
  { id: 'reykjavik', name: '雷克雅未克', ll: { lat: 64.1466, lon: -21.9426 } },
  { id: 'singapore', name: '新加坡', ll: { lat: 1.3521, lon: 103.8198 } },
  { id: 'sydney', name: '悉尼', ll: { lat: -33.8688, lon: 151.2093 } },
  { id: 'capetown', name: '开普敦', ll: { lat: -33.9249, lon: 18.4241 } },
  { id: 'rio', name: '里约热内卢', ll: { lat: -22.9068, lon: -43.1729 } },
  { id: 'anchorage', name: '安克雷奇', ll: { lat: 61.2181, lon: -149.9003 } },
  { id: 'svalbard', name: '斯瓦尔巴', ll: { lat: 78.2232, lon: 15.6469 } },
];

export function getLandmark(id: string): Landmark | undefined {
  return LANDMARKS.find((l) => l.id === id);
}
