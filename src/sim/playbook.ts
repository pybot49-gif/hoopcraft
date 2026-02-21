import { OffenseRole, RoleAction, PlayStep, PlayDef, SlotName, Vec2, GameState, SimPlayer } from './types';
import { getBallHandler, checkIfOpen, dist } from './utils';
import { passBall } from './passing';
import { attemptShot } from './shooting';
import { executeReadAndReact } from './offense';
import { isPassLaneBlocked } from './utils';

function makePlay(name: string, category: string, steps: Array<{
  dur: number; trigger: 'time' | 'pass' | 'position';
  bh: RoleAction; sc: RoleAction; cu: RoleAction; sp: RoleAction; pu: RoleAction;
}>): PlayDef {
  return {
    name, category,
    steps: steps.map((s, i) => ({
      id: i + 1, duration: s.dur, trigger: s.trigger,
      actions: new Map<OffenseRole, RoleAction>([
        ['ballHandler', s.bh], ['screener', s.sc], ['cutter', s.cu], ['spacer', s.sp], ['postUp', s.pu]
      ])
    }))
  };
}

// ─── PICK & ROLL PLAYS (8) ──────────────────────────────────────────────

const PLAY_HORNS_PNR = makePlay('Horns PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_LEFT_WING'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
]);

const PLAY_HORNS_SPLIT = makePlay('Horns Split', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 1.5, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_LOW_POST_R'}, sc: {type:'readAndReact'}, cu: {type:'hold'}, sp: {type:'relocate'}, pu: {type:'screen',target:'ballHandler'} },
]);

const PLAY_SIDE_PNR = makePlay('Side PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_SPAIN_PNR = makePlay('Spain PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'screen',target:'screener'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'pop',slot:'SLOT_LEFT_WING'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_DRAG_PNR = makePlay('Drag Screen', 'pnr', [
  { dur: 1.5, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_WING'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_STEP_UP_PNR = makePlay('Step-Up PnR', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_DOUBLE_DRAG = makePlay('Double Drag', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'screen',target:'ballHandler'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'callForBall'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'roll'} },
]);

const PLAY_PICK_AND_POP = makePlay('Pick & Pop', 'pnr', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── MOTION / PASSING PLAYS (5) ────────────────────────────────────────

const PLAY_FLEX = makePlay('Flex', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_R'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_RIGHT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
]);

const PLAY_UCLA_CUT = makePlay('UCLA Cut', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 1.5, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_L'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'hold'}, sp: {type:'readAndReact'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'callForBall'}, sc: {type:'hold'}, cu: {type:'relocate'}, sp: {type:'readAndReact'}, pu: {type:'hold'} },
]);

const PLAY_PRINCETON_CHIN = makePlay('Princeton Chin', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_RIGHT_CORNER'}, sc: {type:'readAndReact'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_TOP_KEY'} },
]);

const PLAY_SWING = makePlay('Swing Offense', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LEFT_WING'}, pu: {type:'hold'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_LEFT_ELBOW'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'passTo',target:'spacer'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'callForBall'}, sc: {type:'roll'}, cu: {type:'hold'}, sp: {type:'readAndReact'}, pu: {type:'relocate'} },
]);

const PLAY_TRIANGLE = makePlay('Triangle', 'motion', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_TOP_KEY'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'postUp'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_RIGHT_CORNER'}, sc: {type:'readAndReact'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── POST PLAYS (4) ────────────────────────────────────────────────────

const PLAY_POST_UP = makePlay('Post Up', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_TOP_KEY'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_L'} },
  { dur: 2, trigger: 'time', bh: {type:'entryPass',target:'postUp'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 3, trigger: 'time', bh: {type:'relocate'}, sc: {type:'hold'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_HIGH_LOW = makePlay('High-Low', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 3, trigger: 'time', bh: {type:'relocate'}, sc: {type:'entryPass',target:'postUp'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_POST_SPLIT = makePlay('Post Split', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_TOP_KEY'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_L'} },
  { dur: 2, trigger: 'time', bh: {type:'entryPass',target:'postUp'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'callForBall'} },
  { dur: 2, trigger: 'time', bh: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_R'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'readAndReact'} },
]);

const PLAY_ELBOW_POST = makePlay('Elbow Post', 'post', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_LOW_POST_R'}, sc: {type:'readAndReact'}, cu: {type:'relocate'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── SHOOTING PLAYS (4) ────────────────────────────────────────────────

const PLAY_FLOPPY = makePlay('Floppy', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LOW_POST_L'}, cu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_LEFT_ELBOW',to:'SLOT_RIGHT_WING'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'roll'}, cu: {type:'shootIfOpen'}, sp: {type:'hold'}, pu: {type:'pop',slot:'SLOT_RIGHT_ELBOW'} },
]);

const PLAY_HAMMER = makePlay('Hammer', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'left'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'screen',target:'spacer'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'relocate'}, sp: {type:'callForBall'}, pu: {type:'hold'} },
]);

const PLAY_IVERSON_CUT = makePlay('Iverson Cut', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sp: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_TOP_KEY',to:'SLOT_RIGHT_WING'}, sp: {type:'hold'}, pu: {type:'screen',target:'cutter'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'cutter'}, sc: {type:'pop',slot:'SLOT_LEFT_WING'}, cu: {type:'shootIfOpen'}, sp: {type:'relocate'}, pu: {type:'hold'} },
]);

const PLAY_STAGGER_SCREEN = makePlay('Stagger Screen', 'shooting', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LOW_POST_R'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'spacer'}, cu: {type:'hold'}, sp: {type:'cut',from:'SLOT_RIGHT_CORNER',to:'SLOT_LEFT_WING'}, pu: {type:'screen',target:'spacer'} },
  { dur: 3, trigger: 'time', bh: {type:'passTo',target:'spacer'}, sc: {type:'roll'}, cu: {type:'relocate'}, sp: {type:'shootIfOpen'}, pu: {type:'pop',slot:'SLOT_TOP_KEY'} },
]);

// ─── TRANSITION PLAYS (4) ──────────────────────────────────────────────

export const PLAY_FAST_BREAK = makePlay('Fast Break', 'transition', [
  { dur: 1.5, trigger: 'time', bh: {type:'drive',direction:'baseline'}, sc: {type:'relocate'}, cu: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LEFT_CORNER'}, sp: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_RIGHT_CORNER'}, pu: {type:'relocate'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'relocate'}, cu: {type:'callForBall'}, sp: {type:'callForBall'}, pu: {type:'relocate'} },
]);

export const PLAY_SECONDARY_BREAK = makePlay('Secondary Break', 'transition', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_TOP_KEY'}, sc: {type:'moveTo',slot:'SLOT_RIGHT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_WING'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'drive',direction:'right'}, sc: {type:'screen',target:'ballHandler'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'roll'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'relocate'} },
]);

const PLAY_EARLY_OFFENSE = makePlay('Early Offense', 'transition', [
  { dur: 1.5, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_RIGHT_CORNER'}, pu: {type:'moveTo',slot:'SLOT_LOW_POST_R'} },
  { dur: 2, trigger: 'time', bh: {type:'passTo',target:'screener'}, sc: {type:'callForBall'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LOW_POST_L'}, sp: {type:'hold'}, pu: {type:'hold'} },
  { dur: 3, trigger: 'time', bh: {type:'cut',from:'SLOT_RIGHT_WING',to:'SLOT_RIGHT_ELBOW'}, sc: {type:'readAndReact'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

export const PLAY_CHERRY_PICK = makePlay('Cherry Pick', 'transition', [
  { dur: 1, trigger: 'time', bh: {type:'drive',direction:'baseline'}, sc: {type:'relocate'}, cu: {type:'cut',from:'SLOT_LEFT_WING',to:'SLOT_LOW_POST_L'}, sp: {type:'relocate'}, pu: {type:'relocate'} },
  { dur: 2, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'hold'}, cu: {type:'callForBall'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── ISO PLAYS (2) ─────────────────────────────────────────────────────

const PLAY_ISO = makePlay('ISO Clear', 'iso', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, cu: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, sp: {type:'moveTo',slot:'SLOT_LEFT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 4, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'hold'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

const PLAY_ISO_SCREEN_AWAY = makePlay('ISO Screen Away', 'iso', [
  { dur: 2, trigger: 'time', bh: {type:'moveTo',slot:'SLOT_RIGHT_WING'}, sc: {type:'moveTo',slot:'SLOT_LEFT_ELBOW'}, cu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'}, sp: {type:'moveTo',slot:'SLOT_LEFT_WING'}, pu: {type:'moveTo',slot:'SLOT_LEFT_CORNER'} },
  { dur: 2, trigger: 'time', bh: {type:'hold'}, sc: {type:'screen',target:'cutter'}, cu: {type:'cut',from:'SLOT_LEFT_CORNER',to:'SLOT_LEFT_WING'}, sp: {type:'relocate'}, pu: {type:'hold'} },
  { dur: 4, trigger: 'time', bh: {type:'readAndReact'}, sc: {type:'pop',slot:'SLOT_TOP_KEY'}, cu: {type:'hold'}, sp: {type:'hold'}, pu: {type:'hold'} },
]);

// ─── MASTER PLAYBOOK ───────────────────────────────────────────────────

export const PLAYBOOK: PlayDef[] = [
  PLAY_HORNS_PNR, PLAY_HORNS_SPLIT, PLAY_SIDE_PNR, PLAY_SPAIN_PNR,
  PLAY_DRAG_PNR, PLAY_STEP_UP_PNR, PLAY_DOUBLE_DRAG, PLAY_PICK_AND_POP,
  PLAY_FLEX, PLAY_UCLA_CUT, PLAY_PRINCETON_CHIN, PLAY_SWING, PLAY_TRIANGLE,
  PLAY_POST_UP, PLAY_HIGH_LOW, PLAY_POST_SPLIT, PLAY_ELBOW_POST,
  PLAY_FLOPPY, PLAY_HAMMER, PLAY_IVERSON_CUT, PLAY_STAGGER_SCREEN,
  PLAY_FAST_BREAK, PLAY_SECONDARY_BREAK, PLAY_EARLY_OFFENSE, PLAY_CHERRY_PICK,
  PLAY_ISO, PLAY_ISO_SCREEN_AWAY,
];

export function getSlotPositions(basketPos: Vec2, dir: number): Map<SlotName, Vec2> {
  const slots = new Map<SlotName, Vec2>();
  
  slots.set('SLOT_LEFT_CORNER', { x: basketPos.x - dir * 22, y: basketPos.y - 22 });
  slots.set('SLOT_LEFT_WING', { x: basketPos.x - dir * 22, y: basketPos.y - 12 });
  slots.set('SLOT_LEFT_ELBOW', { x: basketPos.x - dir * 15, y: basketPos.y - 7 });
  slots.set('SLOT_TOP_KEY', { x: basketPos.x - dir * 26, y: basketPos.y });
  slots.set('SLOT_RIGHT_ELBOW', { x: basketPos.x - dir * 15, y: basketPos.y + 7 });
  slots.set('SLOT_RIGHT_WING', { x: basketPos.x - dir * 22, y: basketPos.y + 12 });
  slots.set('SLOT_RIGHT_CORNER', { x: basketPos.x - dir * 22, y: basketPos.y + 22 });
  slots.set('SLOT_LOW_POST_L', { x: basketPos.x - dir * 5, y: basketPos.y - 5 });
  slots.set('SLOT_LOW_POST_R', { x: basketPos.x - dir * 5, y: basketPos.y + 5 });
  
  return slots;
}

export let recentPlays: string[] = [];

export function resetRecentPlays(): void {
  recentPlays = [];
}

export function selectPlay(state: GameState, offTeam: SimPlayer[]): void {
  const tactic = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  const rng = state.rng;
  
  let categoryWeights: Record<string, number>;
  
  switch (tactic) {
    case 'fast_break':
      categoryWeights = { transition: 5, pnr: 2, motion: 1, shooting: 1, post: 0, iso: 0 };
      break;
    case 'iso':
      categoryWeights = { iso: 5, pnr: 2, shooting: 1, motion: 1, post: 0, transition: 1 };
      break;
    case 'inside':
      categoryWeights = { post: 5, pnr: 3, motion: 2, shooting: 1, iso: 0, transition: 1 };
      break;
    case 'shoot':
      categoryWeights = { shooting: 5, pnr: 3, motion: 2, post: 1, iso: 1, transition: 1 };
      break;
    case 'motion':
    default:
      categoryWeights = { pnr: 3, motion: 3, shooting: 2, post: 2, iso: 1, transition: 1 };
      break;
  }
  
  const candidates: PlayDef[] = [];
  for (const play of PLAYBOOK) {
    if (recentPlays.includes(play.name)) continue;
    if (play.category === 'transition') continue;
    const weight = categoryWeights[play.category] || 1;
    for (let i = 0; i < weight; i++) candidates.push(play);
  }
  
  const pool = candidates.length > 0 ? candidates : PLAYBOOK.filter(p => p.category !== 'transition');
  const selectedPlay = pool[Math.floor(rng() * pool.length)];
  
  recentPlays.push(selectedPlay.name);
  if (recentPlays.length > 4) recentPlays.shift();
  
  state.currentPlay = selectedPlay;
  state.currentStep = 0;
  state.stepTimer = 0;
}

export function updateCurrentPlay(state: GameState, basketPos: Vec2, dir: number): void {
  if (!state.currentPlay) return;
  
  state.stepTimer += 1 / 60;
  
  const currentStep = state.currentPlay.steps[state.currentStep];
  if (!currentStep) return;
  
  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const slots = getSlotPositions(basketPos, dir);
  
  for (const player of offTeam) {
    if (!player.currentRole) continue;
    
    const action = currentStep.actions.get(player.currentRole);
    if (!action) continue;
    
    executeRoleAction(player, action, state, slots, basketPos, dir);
  }
  
  let shouldAdvance = false;
  
  if (currentStep.trigger === 'time' && state.stepTimer >= currentStep.duration) {
    shouldAdvance = true;
  } else if (currentStep.trigger === 'pass' && state.gameTime - state.lastPassTime < 0.5) {
    shouldAdvance = true;
  } else if (currentStep.trigger === 'position') {
    if (currentStep.triggerCondition) {
      shouldAdvance = currentStep.triggerCondition();
    } else {
      shouldAdvance = state.stepTimer >= currentStep.duration;
    }
  }
  
  if (state.stepTimer >= 5) {
    shouldAdvance = true;
  }
  
  if (shouldAdvance && state.currentStep < state.currentPlay.steps.length - 1) {
    state.currentStep++;
    state.stepTimer = 0;
  } else if (shouldAdvance) {
    state.currentPlay = null;
    state.currentStep = 0;
    state.stepTimer = 0;
  }
}

export function findOpenSlot(player: SimPlayer, state: GameState): void {
  const basketPos = getTeamBasket(state.possession);
  const dir = state.possession === 0 ? 1 : -1;
  const slots = getSlotPositions(basketPos, dir);
  const isBig = player.player.position === 'C' || player.player.position === 'PF';
  
  const interiorSlots: SlotName[] = ['SLOT_LOW_POST_L', 'SLOT_LOW_POST_R', 'SLOT_LEFT_ELBOW', 'SLOT_RIGHT_ELBOW'];
  
  let closestSlot: SlotName | null = null;
  let closestDistance = Infinity;
  
  for (const [slotName, slotPos] of slots.entries()) {
    if (!state.slots.get(slotName)) {
      let distance = dist(player.pos, slotPos);
      if (isBig && interiorSlots.includes(slotName)) distance *= 0.5;
      if (!isBig && interiorSlots.includes(slotName)) distance *= 1.5;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestSlot = slotName;
      }
    }
  }
  
  if (closestSlot) {
    if (player.currentSlot) {
      state.slots.set(player.currentSlot, null);
    }
    state.slots.set(closestSlot, player.id);
    player.currentSlot = closestSlot;
    player.targetPos = { ...slots.get(closestSlot)! };
  }
}

export function assignInitialSlots(state: GameState, offTeam: SimPlayer[], slots: Map<SlotName, Vec2>): void {
  state.slots.clear();
  
  const slotNames: SlotName[] = [
    'SLOT_TOP_KEY',
    'SLOT_LEFT_WING',
    'SLOT_RIGHT_WING',
    'SLOT_LEFT_ELBOW',
    'SLOT_RIGHT_ELBOW',
    'SLOT_LEFT_CORNER',
    'SLOT_RIGHT_CORNER',
    'SLOT_LOW_POST_L',
    'SLOT_LOW_POST_R'
  ];
  
  for (let i = 0; i < Math.min(offTeam.length, slotNames.length); i++) {
    const player = offTeam[i];
    const slot = slotNames[i];
    state.slots.set(slot, player.id);
    player.currentSlot = slot;
  }
}

import { getTeamBasket } from './utils';

function executeRoleAction(player: SimPlayer, action: RoleAction, state: GameState, slots: Map<SlotName, Vec2>, basketPos: Vec2, dir: number): void {
  switch (action.type) {
    case 'moveTo': {
      const slotPos = slots.get(action.slot);
      if (slotPos) {
        player.targetPos = { ...slotPos };
        if (player.currentSlot) {
          state.slots.set(player.currentSlot, null);
        }
        player.currentSlot = action.slot;
        state.slots.set(action.slot, player.id);
      }
      break;
    }
    case 'screen': {
      const targetPlayer = state.players.find(p => p.currentRole === action.target);
      if (targetPlayer) {
        player.targetPos = {
          x: targetPlayer.pos.x + dir * 3,
          y: targetPlayer.pos.y + (state.rng() > 0.5 ? 3 : -3)
        };
        player.isScreening = true;
      }
      break;
    }
    case 'cut': {
      const toPos = slots.get(action.to);
      if (toPos) {
        player.targetPos = { ...toPos };
        player.isCutting = true;
      }
      break;
    }
    case 'drive': {
      let driveTarget = { ...basketPos };
      if (action.direction === 'left') {
        driveTarget.y -= 6;
      } else if (action.direction === 'right') {
        driveTarget.y += 6;
      } else if (action.direction === 'baseline') {
        driveTarget = { ...basketPos };
      }
      player.targetPos = driveTarget;
      player.isCutting = true;
      
      if (player.hasBall && dist(player.pos, basketPos) < 5) {
        attemptShot(state, player, basketPos);
      }
      break;
    }
    case 'roll':
      player.targetPos = {
        x: basketPos.x - dir * 5,
        y: basketPos.y + (state.rng() - 0.5) * 4
      };
      player.isCutting = true;
      break;
    case 'pop': {
      const popPos = slots.get(action.slot);
      if (popPos) {
        player.targetPos = { ...popPos };
      }
      break;
    }
    case 'relocate':
      findOpenSlot(player, state);
      break;
    case 'hold': {
      const atPos = !player.targetPos || dist(player.pos, player.targetPos) < 1.5;
      if (atPos) {
        player.targetPos = {
          x: player.pos.x + (state.rng() - 0.5) * 5,
          y: Math.max(3, Math.min(47, player.pos.y + (state.rng() - 0.5) * 5))
        };
        player.isCutting = true;
      }
      break;
    }
    case 'postUp':
      player.targetPos = {
        x: basketPos.x - dir * 5,
        y: basketPos.y + (state.rng() - 0.5) * 8
      };
      break;
    case 'passTo': {
      const handler = getBallHandler(state);
      if (handler && handler === player) {
        const targetPlayer = state.players.find(p => p.currentRole === action.target && p.teamIdx === state.possession);
        if (targetPlayer && targetPlayer !== handler) {
          passBall(state, handler, targetPlayer);
        }
      }
      break;
    }
    case 'shootIfOpen': {
      const ballHandler = getBallHandler(state);
      if (ballHandler && ballHandler === player) {
        const isOpen = checkIfOpen(player, state);
        if (isOpen) {
          attemptShot(state, player, basketPos);
        }
      }
      break;
    }
    case 'readAndReact': {
      const currentHandler = getBallHandler(state);
      if (currentHandler && currentHandler === player) {
        executeReadAndReact(player, state, basketPos);
      }
      break;
    }
    case 'callForBall':
      break;
    case 'entryPass': {
      const passer = getBallHandler(state);
      if (passer && passer === player) {
        const postPlayer = state.players.find(p => p.currentRole === action.target && p.teamIdx === state.possession);
        if (postPlayer && postPlayer !== passer) {
          if (!isPassLaneBlocked(passer, postPlayer, state)) {
            passBall(state, passer, postPlayer);
          }
        }
      }
      break;
    }
  }
}

export function assignRoles(state: GameState): void {
  if (state.currentPlay && state.roles.size > 0) {
    const carrier = getBallHandler(state);
    if (carrier) {
      const currentBHEntry = [...state.roles.entries()].find(([_, r]) => r === 'ballHandler');
      const currentBHId = currentBHEntry?.[0];
      
      if (currentBHId && currentBHId !== carrier.id) {
        const currentBH = state.players.find(p => p.id === currentBHId);
        const isPG = currentBH?.player.position === 'PG';
        
        if (!isPG) {
          const newHandlerOldRole = state.roles.get(carrier.id) || 'spacer';
          state.roles.set(currentBHId, newHandlerOldRole);
          state.roles.set(carrier.id, 'ballHandler');
        }
      }
    }
    state.players.forEach(p => { p.currentRole = state.roles.get(p.id); });
    return;
  }

  const offTeam = state.players.filter(p => p.teamIdx === state.possession);
  const tactic = state.possession === 0 ? state.homeTacticO : state.awayTacticO;
  
  state.roles.clear();
  
  let ballHandler = getBallHandler(state);
  if (ballHandler) {
    const pg = offTeam.find(p => p.player.position === 'PG');
    if (pg && pg !== ballHandler && !pg.isCutting) {
      state.roles.set(pg.id, 'ballHandler');
      const carrierPos = ballHandler.player.position;
      if (carrierPos === 'C' || carrierPos === 'PF') {
        state.roles.set(ballHandler.id, 'postUp');
      } else {
        state.roles.set(ballHandler.id, 'spacer');
      }
      ballHandler = pg;
    } else {
      state.roles.set(ballHandler.id, 'ballHandler');
    }
  }
  
  const remainingPlayers = offTeam.filter(p => !state.roles.has(p.id));
  
  if (tactic === 'iso' && ballHandler?.player.isSuperstar) {
    remainingPlayers.forEach(p => state.roles.set(p.id, 'spacer'));
  } else {
    const centers = remainingPlayers.filter(p => p.player.position === 'C');
    const forwards = remainingPlayers.filter(p => p.player.position === 'PF');
    
    const screenCandidates = [...centers, ...forwards];
    if (screenCandidates.length > 0) {
      state.roles.set(screenCandidates[0].id, 'screener');
    }
    
    const postCandidates = remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .filter(p => p.player.position === 'C' || p.player.position === 'PF');
    if (postCandidates.length > 0) {
      state.roles.set(postCandidates[0].id, 'postUp');
    }
    
    const cutterCandidates = remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .sort((a, b) => b.player.physical.speed - a.player.physical.speed);
    if (cutterCandidates.length > 0) {
      state.roles.set(cutterCandidates[0].id, 'cutter');
    }
    
    remainingPlayers
      .filter(p => !state.roles.has(p.id))
      .forEach(p => state.roles.set(p.id, 'spacer'));
  }
  
  offTeam.forEach(p => {
    p.currentRole = state.roles.get(p.id);
  });
}
