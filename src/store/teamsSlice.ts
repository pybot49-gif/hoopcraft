import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { OffenseTactic, DefenseTactic } from '../engine/types';
import { metroHawks, bayCityWolves } from '../engine/players';

interface TeamsState {
  homeOffense: OffenseTactic;
  homeDefense: DefenseTactic;
  awayOffense: OffenseTactic;
  awayDefense: DefenseTactic;
}

const initialState: TeamsState = {
  homeOffense: 'motion',
  homeDefense: 'man',
  awayOffense: 'fast_break',
  awayDefense: 'zone',
};

export const teamsSlice = createSlice({
  name: 'teams',
  initialState,
  reducers: {
    setHomeOffense: (state, action: PayloadAction<OffenseTactic>) => { state.homeOffense = action.payload; },
    setHomeDefense: (state, action: PayloadAction<DefenseTactic>) => { state.homeDefense = action.payload; },
    setAwayOffense: (state, action: PayloadAction<OffenseTactic>) => { state.awayOffense = action.payload; },
    setAwayDefense: (state, action: PayloadAction<DefenseTactic>) => { state.awayDefense = action.payload; },
  },
});

export const { setHomeOffense, setHomeDefense, setAwayOffense, setAwayDefense } = teamsSlice.actions;
export { metroHawks, bayCityWolves };
export default teamsSlice.reducer;
