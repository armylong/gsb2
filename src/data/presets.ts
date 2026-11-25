// 由 scripts/gen-presets.ts 生成, 请勿手改。运行 npm run gen:presets 重新生成。
import type { Puzzle } from '../core/types.js';

export interface PresetInfo {
  puzzle: Puzzle;
  /** 生成时用求解器验证的性质 */
  verified: string;
}

export const PRESETS: PresetInfo[] = [
  {
    verified: "唯一解(含 1 片锁定); 求解器验证解数 = 1",
    puzzle: {
        "name": "唯一解题面(3×3)",
        "board": {
            "width": 3,
            "height": 3,
            "holes": [],
            "edgeConditions": {
                "0,0,0": "P",
                "0,0,3": "X",
                "1,0,0": "X",
                "2,0,0": "R",
                "2,0,1": "K",
                "0,1,3": "D",
                "2,1,1": "D",
                "0,2,2": "J",
                "0,2,3": "S",
                "1,2,2": "E",
                "2,2,1": "A",
                "2,2,2": "K"
            }
        },
        "tiles": [
            {
                "id": "T1",
                "edges": [
                    "P",
                    "A",
                    "M",
                    "X"
                ]
            },
            {
                "id": "T2",
                "edges": [
                    "X",
                    "G",
                    "P",
                    "A"
                ]
            },
            {
                "id": "T3",
                "edges": [
                    "R",
                    "K",
                    "X",
                    "G"
                ]
            },
            {
                "id": "T4",
                "edges": [
                    "M",
                    "L",
                    "L",
                    "D"
                ]
            },
            {
                "id": "T5",
                "edges": [
                    "P",
                    "J",
                    "F",
                    "L"
                ]
            },
            {
                "id": "T6",
                "edges": [
                    "X",
                    "D",
                    "L",
                    "J"
                ]
            },
            {
                "id": "T7",
                "edges": [
                    "L",
                    "B",
                    "J",
                    "S"
                ]
            },
            {
                "id": "T8",
                "edges": [
                    "F",
                    "G",
                    "E",
                    "B"
                ]
            },
            {
                "id": "T9",
                "edges": [
                    "L",
                    "A",
                    "K",
                    "G"
                ]
            }
        ],
        "placements": [
            {
                "tileId": "T1",
                "x": 0,
                "y": 0,
                "rot": 0,
                "locked": true
            }
        ]
    },
  },
  {
    verified: "多解; 求解器验证解数 ≥ 8(上限内)",
    puzzle: {
        "name": "多解题面(中心留洞)",
        "board": {
            "width": 3,
            "height": 3,
            "holes": [
                {
                    "x": 1,
                    "y": 1
                }
            ],
            "edgeConditions": {
                "0,0,0": "A",
                "0,0,3": "C",
                "1,0,0": "B",
                "1,0,2": "C",
                "2,0,0": "B",
                "2,0,1": "C",
                "0,1,1": "B",
                "0,1,3": "B",
                "2,1,1": "A",
                "2,1,3": "C",
                "0,2,2": "C",
                "0,2,3": "C",
                "1,2,0": "A",
                "1,2,2": "C",
                "2,2,1": "B",
                "2,2,2": "B"
            }
        },
        "tiles": [
            {
                "id": "T1",
                "edges": [
                    "A",
                    "C",
                    "B",
                    "C"
                ]
            },
            {
                "id": "T2",
                "edges": [
                    "B",
                    "A",
                    "C",
                    "C"
                ]
            },
            {
                "id": "T3",
                "edges": [
                    "B",
                    "C",
                    "A",
                    "A"
                ]
            },
            {
                "id": "T4",
                "edges": [
                    "B",
                    "B",
                    "B",
                    "B"
                ]
            },
            {
                "id": "T5",
                "edges": [
                    "A",
                    "A",
                    "B",
                    "C"
                ]
            },
            {
                "id": "T6",
                "edges": [
                    "B",
                    "A",
                    "C",
                    "C"
                ]
            },
            {
                "id": "T7",
                "edges": [
                    "A",
                    "C",
                    "C",
                    "A"
                ]
            },
            {
                "id": "T8",
                "edges": [
                    "B",
                    "B",
                    "B",
                    "C"
                ]
            }
        ],
        "placements": []
    },
  },
  {
    verified: "无解; 深度诊断可无冲突连放 3 块, 最后 1 块无处可放",
    puzzle: {
        "name": "陷阱题面(最后缺一块)",
        "board": {
            "width": 2,
            "height": 2,
            "holes": [],
            "edgeConditions": {
                "0,0,0": "A",
                "0,0,3": "B",
                "1,0,0": "D",
                "1,0,1": "B",
                "0,1,2": "B",
                "0,1,3": "C",
                "1,1,1": "C",
                "1,1,2": "B"
            }
        },
        "tiles": [
            {
                "id": "T1",
                "edges": [
                    "A",
                    "C",
                    "B",
                    "B"
                ]
            },
            {
                "id": "T2",
                "edges": [
                    "D",
                    "B",
                    "B",
                    "C"
                ]
            },
            {
                "id": "T3",
                "edges": [
                    "B",
                    "C",
                    "B",
                    "C"
                ]
            },
            {
                "id": "T4",
                "edges": [
                    "C",
                    "C",
                    "B",
                    "D"
                ]
            }
        ],
        "placements": []
    },
  },
];
