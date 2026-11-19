import { axialKey, axialToOffset, inMap, MAP_COLS, MAP_ROWS, offsetToAxial } from './hex';
import type { Axial, Cell, CellKey, Offset, Terrain } from './types';

export function cellKey(q: number, r: number): CellKey {
  return axialKey(q, r);
}

export function isWalkableTerrain(terrain: Terrain, doorOpen: boolean | undefined): boolean {
  if (terrain === 'floor') return true;
  if (terrain === 'door') return doorOpen === true;
  return false;
}

/** Fully blocks sight: walls always, doors only while closed. */
export function isOpaqueTerrain(terrain: Terrain, doorOpen: boolean | undefined): boolean {
  if (terrain === 'wall') return true;
  if (terrain === 'door') return doorOpen !== true;
  return false;
}

export class GameMap {
  readonly cols = MAP_COLS;
  readonly rows = MAP_ROWS;
  private readonly cells: Cell[] = [];

  constructor() {
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const { q, r } = offsetToAxial(col, row);
        this.cells.push({ q, r, terrain: 'floor' });
      }
    }
  }

  static fromSerialised(rowsOfTiles: string[]): GameMap {
    const map = new GameMap();
    if (rowsOfTiles.length !== MAP_ROWS) {
      throw new Error(`map needs ${MAP_ROWS} rows, received ${rowsOfTiles.length}`);
    }
    rowsOfTiles.forEach((line, row) => {
      const trimmed = line.trim();
      const tokens = /\s/.test(trimmed) ? trimmed.split(/\s+/) : [...trimmed];
      if (tokens.length !== MAP_COLS) {
        throw new Error(`map row ${row} needs ${MAP_COLS} tokens, received ${tokens.length}`);
      }
      tokens.forEach((token, col) => {
        const cell = map.getAtOffset(col, row);
        switch (token) {
          case '.':
            cell.terrain = 'floor';
            break;
          case '#':
            cell.terrain = 'wall';
            break;
          case 'D':
            cell.terrain = 'door';
            cell.doorOpen = true;
            break;
          case 'd':
            cell.terrain = 'door';
            cell.doorOpen = false;
            break;
          default:
            throw new Error(`unknown map token "${token}" at ${col},${row}`);
        }
      });
    });
    return map;
  }

  getAtOffset(col: number, row: number): Cell {
    if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) {
      throw new Error(`offset ${col},${row} outside map`);
    }
    const { q, r } = offsetToAxial(col, row);
    // Cells were pushed row-major in the same order as the loops above.
    return this.cells[row * MAP_COLS + col]!;
  }

  get(q: number, r: number): Cell | undefined {
    if (!inMap(q, r)) return undefined;
    const { col, row } = axialToOffset(q, r);
    return this.getAtOffset(col, row);
  }

  getOrThrow(q: number, r: number): Cell {
    const cell = this.get(q, r);
    if (!cell) throw new Error(`cell ${q},${r} is outside the map`);
    return cell;
  }

  get size(): number {
    return this.cells.length;
  }

  all(): readonly Cell[] {
    return this.cells;
  }

  offsetOf(cell: Cell | Axial): Offset {
    return axialToOffset(cell.q, cell.r);
  }

  isInsideMap(q: number, r: number): boolean {
    return inMap(q, r);
  }

  isWalkable(q: number, r: number): boolean {
    const cell = this.get(q, r);
    if (!cell) return false;
    return isWalkableTerrain(cell.terrain, cell.doorOpen);
  }

  setTerrain(q: number, r: number, terrain: Terrain): void {
    const cell = this.getOrThrow(q, r);
    cell.terrain = terrain;
    if (terrain === 'door') {
      cell.doorOpen = cell.doorOpen === true;
    } else {
      delete cell.doorOpen;
    }
  }

  toggleDoor(q: number, r: number): boolean {
    const cell = this.getOrThrow(q, r);
    if (cell.terrain !== 'door') return false;
    cell.doorOpen = !cell.doorOpen;
    return true;
  }

  /** Doors in map order, handy for UI lists. */
  doors(): Cell[] {
    return this.cells.filter((c) => c.terrain === 'door');
  }
}
