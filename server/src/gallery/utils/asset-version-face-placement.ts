import { AssetEditAction, type AssetEditActionItem } from 'src/dtos/editing.dto.js';

// Face boxes on a photo that shows an edit (specs/2026-11-07-asset-versions-design.md, "Face boxes on a shown edit").
//
// Faces are found on the photo's own file, and their boxes are kept in that picture's pixels. A photo with versions
// shows its newest edit, which is often cropped or straightened, so the boxes would sit in the wrong place. Editors
// do not agree on how to record a crop, and most record none, so the edit's file is not asked. The faces are:
// they are found once more on the edit's picture, each is paired with the same face on the photo, and from the pairs
// comes the one thing that is stored: where the edit's picture sits on the photo (a `Placement`). Given to Gallery's
// own box transform as a crop and a turn, it puts the photo's faces where they were found on the edit. Nothing else
// is written: no face is moved, hidden or reassigned.
//
// A placement can be wrong where the faces say too little: a mirrored edit with two faces reads as a half turn, two
// faces close together give a turn that is a few degrees off, and one face cannot tell a turn at all. The boxes of
// the paired faces still land on them; other boxes of that photo are then drawn off, or not at all, until the photo
// shows another picture. Telling these cases apart would take much more than the faces give.
//
// Everything here is plain arithmetic on sizes and boxes: no database, no files, no machine learning.

export type Size = { width: number; height: number };

/** A face's box, in the pixels of the picture it was found on. */
export type Box = { x1: number; y1: number; x2: number; y2: number };

/** One face, found on the photo's own picture and on the edit's. */
export type FacePair = { photo: Box; edit: Box };

/**
Where the edit's picture sits on the photo: a rectangle of the photo (`x`, `y`, `width`, `height` as 0–1 of the
photo's frame), turned by `angle` degrees clockwise about its own centre (-180…180). The whole photo is
`{0, 0, 1, 1, 0}`; the whole photo turned on its side is `{0, 0, 1, 1, 90}`, and the edit's picture is then as
wide as the rectangle is tall.
*/
export type Placement = { x: number; y: number; width: number; height: number; angle: number };

export type PlacementResult = { placement: Placement } | { placement: null; reason: string };

/** Overlap (0–1) above which a box counts as sitting on its face: the measure Gallery's face job matches boxes by. */
const ON_ITS_FACE = 0.5;
/** Overlap at which the boxes are close enough as they are, and no placement is kept. */
const CLOSE_ENOUGH = 0.8;
/** How far (as a share of the photo) the edit may reach past the photo's edge: a crop shows nothing the photo lacks. */
const PAST_THE_EDGE = 0.05;

const THE_WHOLE_PHOTO: Placement = { x: 0, y: 0, width: 1, height: 1, angle: 0 };

const area = (box: Box) => Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
const centre = (box: Box) => ({ x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 });

/** How much two boxes overlap: the area they share over the area they cover together (0–1). */
export const overlap = (a: Box, b: Box) => {
  const shared = area({
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  });
  const covered = area(a) + area(b) - shared;
  return covered > 0 ? shared / covered : 0;
};

const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

/** How alike two recognition vectors are: the cosine of the angle between them (1 for the same direction). */
const similarity = (a: number[], b: number[]) => {
  const lengths = Math.sqrt(dot(a, a) * dot(b, b));
  return lengths > 0 ? dot(a, b) / lengths : 0;
};

/**
Pairs the faces found on the edit with the same faces on the photo, by their recognition vectors: the most alike
two first, each face used once, and only pairs at least `minSimilarity` alike (cosine, 0–1). A face cut out of the
edit, or found on one picture only, stays unpaired.
*/
export const pairFaces = (
  photoFaces: Array<{ box: Box; vector: number[] }>,
  editFaces: Array<{ box: Box; vector: number[] }>,
  minSimilarity: number,
): FacePair[] => {
  const alike = photoFaces
    .flatMap((photo, photoIndex) =>
      editFaces.map((edit, editIndex) => ({ photoIndex, editIndex, score: similarity(photo.vector, edit.vector) })),
    )
    .filter(({ score }) => score >= minSimilarity)
    .toSorted((a, b) => b.score - a.score);

  const pairs: FacePair[] = [];
  const usedPhoto = new Set<number>();
  const usedEdit = new Set<number>();
  for (const { photoIndex, editIndex } of alike) {
    if (usedPhoto.has(photoIndex) || usedEdit.has(editIndex)) {
      continue;
    }
    usedPhoto.add(photoIndex);
    usedEdit.add(editIndex);
    pairs.push({ photo: photoFaces[photoIndex].box, edit: editFaces[editIndex].box });
  }
  return pairs;
};

/** The quarter turns in an angle (0–3): a turn is so many of them and a rest of at most 45 degrees either way. */
const quarterTurns = (angle: number) => ((Math.round(angle / 90) % 4) + 4) % 4;
/** Whether a picture turned by this angle lies on its side: its width runs along the photo's height. */
const onItsSide = (angle: number) => quarterTurns(angle) % 2 === 1;

/** A point of the photo → a point of the edit: enlarged by `scale`, turned (`cos`, `sin`; clockwise), then shifted. */
type Mapping = { scale: number; cos: number; sin: number; shiftX: number; shiftY: number };

/**
The mapping that best puts the photo's faces on the edit's. One face tells how much larger it became and where it
went; two or more also tell the turn, and their centres are fitted together (least squares).
*/
const fitMapping = (pairs: FacePair[]): Mapping => {
  const count = pairs.length;
  const photoCentres = pairs.map(({ photo }) => centre(photo));
  const editCentres = pairs.map(({ edit }) => centre(edit));
  const mean = (points: Array<{ x: number; y: number }>) => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count,
  });
  const photoMean = mean(photoCentres);
  const editMean = mean(editCentres);

  // how the centres spread around their middle on each picture, taken together
  let along = 0;
  let across = 0;
  let spread = 0;
  for (let index = 0; index < count; index++) {
    const px = photoCentres[index].x - photoMean.x;
    const py = photoCentres[index].y - photoMean.y;
    const ex = editCentres[index].x - editMean.x;
    const ey = editCentres[index].y - editMean.y;
    along += px * ex + py * ey;
    across += px * ey - py * ex;
    spread += px * px + py * py;
  }

  let scale: number;
  let cos = 1;
  let sin = 0;
  if (spread > 0 && Math.hypot(along, across) > 0) {
    scale = Math.hypot(along, across) / spread;
    cos = along / Math.hypot(along, across);
    sin = across / Math.hypot(along, across);
  } else {
    // one face (or several on one spot): only its size tells the scale, and nothing tells a turn
    const photoArea = pairs.reduce((sum, { photo }) => sum + area(photo), 0);
    const editArea = pairs.reduce((sum, { edit }) => sum + area(edit), 0);
    scale = Math.sqrt(editArea / photoArea);
  }
  return {
    scale,
    cos,
    sin,
    shiftX: editMean.x - scale * (cos * photoMean.x - sin * photoMean.y),
    shiftY: editMean.y - scale * (sin * photoMean.x + cos * photoMean.y),
  };
};

/** The part of the photo that such a mapping shows as the edit's whole picture. */
const toPlacement = ({ scale, cos, sin, shiftX, shiftY }: Mapping, photo: Size, edit: Size): Placement => {
  const angle = (Math.atan2(sin, cos) * 180) / Math.PI;
  // the rectangle as it lies on the photo, before the turn: on its side, the edit's width runs along its height
  const width = (onItsSide(angle) ? edit.height : edit.width) / scale;
  const height = (onItsSide(angle) ? edit.width : edit.height) / scale;
  // the point of the photo that lands in the middle of the edit
  const fromShiftX = edit.width / 2 - shiftX;
  const fromShiftY = edit.height / 2 - shiftY;
  const middleX = (cos * fromShiftX + sin * fromShiftY) / scale;
  const middleY = (-sin * fromShiftX + cos * fromShiftY) / scale;
  return {
    x: (middleX - width / 2) / photo.width,
    y: (middleY - height / 2) / photo.height,
    width: width / photo.width,
    height: height / photo.height,
    angle,
  };
};

/**
Where a box of the photo falls on the edit, for an edit placed like this: Immich's own box transform
(`transformFaceBoundingBox` with `placementEdits`), in the edit's pixels.
*/
export const placeBox = (placement: Placement, photo: Size, edit: Size, box: Box): Box => {
  const width = placement.width * photo.width;
  const height = placement.height * photo.height;
  const middleX = placement.x * photo.width + width / 2;
  const middleY = placement.y * photo.height + height / 2;
  const turn = (placement.angle * Math.PI) / 180;
  // the frame the turned rectangle fills, in the photo's pixels
  const frameWidth = onItsSide(placement.angle) ? height : width;
  const frameHeight = onItsSide(placement.angle) ? width : height;
  const place = (x: number, y: number) => ({
    x: ((Math.cos(turn) * (x - middleX) - Math.sin(turn) * (y - middleY)) / frameWidth + 0.5) * edit.width,
    y: ((Math.sin(turn) * (x - middleX) + Math.cos(turn) * (y - middleY)) / frameHeight + 0.5) * edit.height,
  });
  const a = place(box.x1, box.y1);
  const b = place(box.x2, box.y2);
  return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
};

/**
Where a face of the photo is on the edit, for an edit placed like this: an upright box around the spot its centre
goes to, as much larger as the picture became. This is where a second detection finds it, turned picture or not,
and what the fit is checked against. (`placeBox`, through Immich's transform, draws a box from two of its corners, which
loses its shape between quarter turns.)
*/
const placeFace = (placement: Placement, photo: Size, edit: Size, box: Box): Box => {
  const sideways = onItsSide(placement.angle);
  const middle = centre(box);
  const spot = placeBox(placement, photo, edit, { x1: middle.x, y1: middle.y, x2: middle.x, y2: middle.y });
  const frameWidth = (sideways ? placement.height * photo.height : placement.width * photo.width) || 1;
  const larger = edit.width / frameWidth;
  const width = (sideways ? box.y2 - box.y1 : box.x2 - box.x1) * larger;
  const height = (sideways ? box.x2 - box.x1 : box.y2 - box.y1) * larger;
  return { x1: spot.x1 - width / 2, y1: spot.y1 - height / 2, x2: spot.x1 + width / 2, y2: spot.y1 + height / 2 };
};

/** Whether the placed rectangle stays on the photo, give or take `PAST_THE_EDGE`. */
const staysOnThePhoto = ({ x, y, width, height, angle }: Placement, photo: Size) => {
  const turn = (angle * Math.PI) / 180;
  const middleX = (x + width / 2) * photo.width;
  const middleY = (y + height / 2) * photo.height;
  // half the frame the turned rectangle fills
  const halfWidth = (onItsSide(angle) ? height * photo.height : width * photo.width) / 2;
  const halfHeight = (onItsSide(angle) ? width * photo.width : height * photo.height) / 2;
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].every(([dx, dy]) => {
    // the corner of the edit's frame, turned back onto the photo
    const cornerX = (middleX + Math.cos(turn) * dx + Math.sin(turn) * dy) / photo.width;
    const cornerY = (middleY - Math.sin(turn) * dx + Math.cos(turn) * dy) / photo.height;
    return [cornerX, cornerY].every((share) => share >= -PAST_THE_EDGE && share <= 1 + PAST_THE_EDGE);
  });
};

/**
Where the edit's picture sits on the photo, from the faces found on both; or none, with the reason.

`photo` and `edit` are the sizes of the two pictures, each in the pixels its faces' boxes are in.

1. Without a face found on both there is nothing to go by.
2. When the photo's boxes already sit on the edit's faces as they are (the same frame at another resolution, or a
   trim too small to see), nothing is kept.
3. Otherwise the placement is fitted to the pairs, and kept only when it makes sense: a part of the photo, turned
   by any angle, that puts every paired face on the spot where it was found.
*/
export const fitPlacement = (photo: Size, edit: Size, pairs: FacePair[]): PlacementResult => {
  const none = (reason: string): PlacementResult => ({ placement: null, reason });
  const lands = (placement: Placement, atLeast: number) =>
    pairs.every((pair) => overlap(placeFace(placement, photo, edit, pair.photo), pair.edit) >= atLeast);

  if (pairs.length === 0) {
    return none('no face was found on both pictures');
  }
  if (lands(THE_WHOLE_PHOTO, CLOSE_ENOUGH)) {
    return none('the faces are already in place');
  }

  const placement = toPlacement(fitMapping(pairs), photo, edit);
  if (Object.values(placement).some((value) => !Number.isFinite(value)) || placement.width <= 0) {
    return none('the faces give no usable placement');
  }
  if (!staysOnThePhoto(placement, photo)) {
    return none('the edit would show more than the photo has');
  }
  if (!lands(placement, ON_ITS_FACE)) {
    return none('the faces do not agree on one placement');
  }
  return { placement };
};

/**
The placement as edits of Immich's editor (a crop and a turn), in the pixels of the photo's upright frame: what
Immich's face and text box transforms take (`transformFaceBoundingBox`, `transformOcrBoundingBox`, and the way back for a box drawn by hand).
Never stored as edits of the photo: a turn that is not a quarter turn is not one Gallery's editor can make.
*/
export const placementEdits = (placement: Placement, photo: Size): AssetEditActionItem[] => {
  const edits: AssetEditActionItem[] = [
    {
      action: AssetEditAction.Crop,
      parameters: {
        x: Math.round(placement.x * photo.width),
        y: Math.round(placement.y * photo.height),
        width: Math.round(placement.width * photo.width),
        height: Math.round(placement.height * photo.height),
      },
    },
  ];
  // a turn on its side changes the frame, which Gallery does for a quarter turn only: so the quarter turns first,
  // then the rest (at most 45 degrees either way), which keeps the frame
  const quarters = quarterTurns(placement.angle) * 90;
  const rest = ((((placement.angle - quarters) % 360) + 540) % 360) - 180;
  if (quarters !== 0) {
    edits.push({ action: AssetEditAction.Rotate, parameters: { angle: quarters } });
  }
  if (Math.abs(rest) > 1e-9) {
    edits.push({ action: AssetEditAction.Rotate, parameters: { angle: rest } });
  }
  return edits;
};

/** A box as Gallery shows it: in the pixels of the picture it is shown on (Immich's face response has this shape). */
export type ShownBox = {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

/**
Whether a box, once placed on the picture a photo shows, is still in that picture: at least half of it, the share
Gallery asks of a face after a crop in its own editor. A face the shown edit cut out lands outside and is not
drawn. Nothing about it is changed: it stays on the photo, in its person's list, and has its box again when the
photo shows its own file. A box or a picture without a size is left as it is.
*/
export const isInPicture = (box: ShownBox) => {
  const whole = area({ x1: box.boundingBoxX1, y1: box.boundingBoxY1, x2: box.boundingBoxX2, y2: box.boundingBoxY2 });
  if (whole <= 0 || box.imageWidth <= 0 || box.imageHeight <= 0) {
    return true;
  }
  const inside = area({
    x1: Math.max(box.boundingBoxX1, 0),
    y1: Math.max(box.boundingBoxY1, 0),
    x2: Math.min(box.boundingBoxX2, box.imageWidth),
    y2: Math.min(box.boundingBoxY2, box.imageHeight),
  });
  return inside / whole >= 0.5;
};
