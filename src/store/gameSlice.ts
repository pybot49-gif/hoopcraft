import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { GameResult } from '../engine/types';

interface GameState {
  result: GameResult | null;
  seed: number;
}

const initialState: GameState = {
  result: null,
  seed: Date.now(),
};

export const gameSlice = createSlice({
  name: 'game',
  initialState,
  reducers: {
    setResult: (state, action: PayloadAction<GameResult>) => { state.result = action.payload; },
    setSeed: (state, action: PayloadAction<number>) => { state.seed = action.payload; },
    clearResult: (state) => { state.result = null; },
  },
});

export const { setResult, setSeed, clearResult } = gameSlice.actions;
export default gameSlice.reducer;
