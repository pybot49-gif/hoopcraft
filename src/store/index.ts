import { configureStore } from '@reduxjs/toolkit';
import teamsReducer from './teamsSlice';
import gameReducer from './gameSlice';
import uiReducer from './uiSlice';

export const store = configureStore({
  reducer: {
    teams: teamsReducer,
    game: gameReducer,
    ui: uiReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
