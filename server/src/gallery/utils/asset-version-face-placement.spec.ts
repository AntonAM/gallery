import {
  fitPlacement,
  isInPicture,
  overlap,
  pairFaces,
  placeBox,
  placementEdits,
  type Box,
  type FacePair,
  type Placement,
  type Size,
} from 'src/gallery/utils/asset-version-face-placement.js';
import { convertFaceBoxToOriginalImageSpace } from 'src/utils/asset.util.js';
import { getOutputDimensions, transformFaceBoundingBox } from 'src/utils/transform.js';

// Simulated edits. A case says how an editor cut the edit out of the photo (the truth), where the faces are on the
// photo, and how much a second face detection wobbles. The simulator works out where each face is found on the edit.
// The check is the feature's goal itself: the placement that comes out, given to GALLERY'S OWN box transform, must
// put the photo's boxes on the faces of the edit.

const CAMERA: Size = { width: 6000, height: 4000 };

/** A face box of this size around a point of the photo. */
const face = (x: number, y: number, size = 400): Box => ({
  x1: x - size / 2,
  y1: y - size / 2,
  x2: x + size / 2,
  y2: y + size / 2,
});

/** Repeatable "random" numbers in -1…1, so a failing case fails the same way every time. */
const wobbler = (seed: number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 2_147_483_648 - 1;
};

/** A box of this width and height around a point. */
const around = (x: number, y: number, w: number, h: number): Box => ({
  x1: x - w / 2,
  y1: y - h / 2,
  x2: x + w / 2,
  y2: y + h / 2,
});

/** The same person again, seen a little differently. */
const again = (vector: number[]) => vector.map((value, index) => value * 0.9 + (index === 3 ? 0.2 : 0.05));

/** /** Whether a turn by this angle lays a picture on its side (nearer to a quarter turn than to none or a half turn). */
const isOnItsSide = (angle: number) => Math.abs(Math.round(angle / 90)) % 2 === 1;

/**
Where a point of the photo is on the edit, for an edit cut out like `truth`. Written out here on its own, step by
step, and not taken from the code under test: move to the cut's centre, turn about it, then resize.
*/
const onTheEdit = (truth: Placement, photo: Size, edit: Size, point: { x: number; y: number }) => {
  const cutWidth = truth.width * photo.width;
  const cutHeight = truth.height * photo.height;
  const fromCentreX = point.x - truth.x * photo.width - cutWidth / 2;
  const fromCentreY = point.y - truth.y * photo.height - cutHeight / 2;
  const radians = (truth.angle * Math.PI) / 180;
  const turnedX = fromCentreX * Math.cos(radians) - fromCentreY * Math.sin(radians);
  const turnedY = fromCentreX * Math.sin(radians) + fromCentreY * Math.cos(radians);
  // a picture turned on its side fills a frame as wide as the cut is tall
  const frame = isOnItsSide(truth.angle)
    ? { width: cutHeight, height: cutWidth }
    : { width: cutWidth, height: cutHeight };
  return { x: (turnedX / frame.width + 0.5) * edit.width, y: (turnedY / frame.height + 0.5) * edit.height };
};

type Simulated = {
  photo: Size;
  edit: Size;
  /** Faces found on both pictures: what the fit is given. */
  pairs: FacePair[];
  /** Every face of the photo that is still in the edit's frame, with the spot it truly has there (no wobble). */
  inFrame: Array<{ photo: Box; edit: Box }>;
};

/**
An edit cut out of `photo` like `truth` and saved at the size `edit`. A second detection finds each face that is
still in the frame: an upright box around its new spot, as much larger as the picture became, and off by up to
`wobble` (a share of the face's size) in position and in size.
*/
const simulate = ({
  photo = CAMERA,
  edit,
  truth,
  faces,
  wobble = 0,
  seed = 1,
}: {
  photo?: Size;
  edit: Size;
  truth: Placement;
  faces: Box[];
  wobble?: number;
  seed?: number;
}): Simulated => {
  const random = wobbler(seed);
  const larger = edit.width / (isOnItsSide(truth.angle) ? truth.height * photo.height : truth.width * photo.width);
  const inFrame: Simulated['inFrame'] = [];
  const pairs: FacePair[] = [];
  for (const box of faces) {
    const spot = onTheEdit(truth, photo, edit, { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 });
    if (spot.x < 0 || spot.y < 0 || spot.x > edit.width || spot.y > edit.height) {
      continue; // cut out of the edit
    }
    const width = (box.x2 - box.x1) * larger;
    const height = (box.y2 - box.y1) * larger;
    inFrame.push({ photo: box, edit: around(spot.x, spot.y, width, height) });
    pairs.push({
      photo: box,
      edit: around(
        spot.x + random() * wobble * width,
        spot.y + random() * wobble * height,
        width * (1 + random() * wobble),
        height * (1 + random() * wobble),
      ),
    });
  }
  return { photo, edit, pairs, inFrame };
};

/** A box of the photo, put on the edit by Gallery's own transform with the edits the placement turns into. */
const galleryPlaces = (placement: Placement, photo: Size, edit: Size, box: Box): Box => {
  const placed = transformFaceBoundingBox(
    {
      boundingBoxX1: box.x1,
      boundingBoxY1: box.y1,
      boundingBoxX2: box.x2,
      boundingBoxY2: box.y2,
      imageWidth: photo.width,
      imageHeight: photo.height,
    },
    placementEdits(placement, photo),
    photo,
  );
  // Gallery answers in the cut's own pixels; the web draws by share of the frame, so the edit's size is a plain resize
  const toEditX = edit.width / placed.imageWidth;
  const toEditY = edit.height / placed.imageHeight;
  return {
    x1: placed.boundingBoxX1 * toEditX,
    y1: placed.boundingBoxY1 * toEditY,
    x2: placed.boundingBoxX2 * toEditX,
    y2: placed.boundingBoxY2 * toEditY,
  };
};

const fit = (simulated: Simulated) => fitPlacement(simulated.photo, simulated.edit, simulated.pairs);

/**
Fits the case and checks that every face still in the frame is put on its true spot: the box overlaps the face by
at least `atLeast`, and its centre is within `offCentre` (a share of the face's size) of the face's centre.
*/
const expectFacesInPlace = (simulated: Simulated, atLeast: number, offCentre = 0.1) => {
  const result = fit(simulated);
  expect(result, JSON.stringify(result)).toHaveProperty('placement');
  expect(result.placement).not.toBeNull();
  for (const { photo, edit } of simulated.inFrame) {
    const placed = galleryPlaces(result.placement!, simulated.photo, simulated.edit, photo);
    expect(overlap(placed, edit), `${JSON.stringify(placed)} on ${JSON.stringify(edit)}`).toBeGreaterThanOrEqual(
      atLeast,
    );
    const off = Math.hypot(
      (placed.x1 + placed.x2 - edit.x1 - edit.x2) / 2,
      (placed.y1 + placed.y2 - edit.y1 - edit.y2) / 2,
    );
    expect(off / (edit.x2 - edit.x1), 'off centre, in face widths').toBeLessThanOrEqual(offCentre);
  }
  return result.placement!;
};

/** A cut of the photo given in its pixels. */
const cut = (photo: Size, x: number, y: number, width: number, height: number, angle = 0): Placement => ({
  x: x / photo.width,
  y: y / photo.height,
  width: width / photo.width,
  height: height / photo.height,
  angle,
});

const FAMILY = [face(1500, 1400), face(3000, 1700, 460), face(4300, 1500, 380), face(2400, 2600, 300)];

describe('overlap', () => {
  it('is 1 for the same box, 0 for boxes apart, and the shared share in between', () => {
    expect(overlap(face(100, 100, 100), face(100, 100, 100))).toBe(1);
    expect(overlap(face(100, 100, 100), face(500, 500, 100))).toBe(0);
    // shifted by half its width: half of each is shared, so 50 of 150
    expect(overlap(face(100, 100, 100), face(150, 100, 100))).toBeCloseTo(1 / 3, 6);
  });

  it('is 0 for an empty box', () => {
    expect(overlap({ x1: 5, y1: 5, x2: 5, y2: 5 }, { x1: 5, y1: 5, x2: 5, y2: 5 })).toBe(0);
  });
});

describe('pairFaces', () => {
  const anna = [1, 0, 0, 0];
  const boris = [0, 1, 0, 0];
  const clara = [0, 0, 1, 0];

  it('pairs each face with the same person, whatever order they were found in', () => {
    const pairs = pairFaces(
      [
        { box: face(100, 100), vector: anna },
        { box: face(200, 200), vector: boris },
      ],
      [
        { box: face(20, 20), vector: again(boris) },
        { box: face(10, 10), vector: again(anna) },
      ],
      0.5,
    );
    expect(pairs).toEqual(
      expect.arrayContaining([
        { photo: face(100, 100), edit: face(10, 10) },
        { photo: face(200, 200), edit: face(20, 20) },
      ]),
    );
    expect(pairs).toHaveLength(2);
  });

  it('leaves out a face that is on one picture only', () => {
    const pairs = pairFaces(
      [
        { box: face(100, 100), vector: anna },
        { box: face(200, 200), vector: boris }, // cut out of the edit
      ],
      [
        { box: face(10, 10), vector: again(anna) },
        { box: face(30, 30), vector: clara }, // found on the edit only
      ],
      0.5,
    );
    expect(pairs).toEqual([{ photo: face(100, 100), edit: face(10, 10) }]);
  });

  it('pairs nothing when no two faces are alike enough', () => {
    expect(pairFaces([{ box: face(1, 1), vector: anna }], [{ box: face(2, 2), vector: boris }], 0.5)).toEqual([]);
    // alike, but not enough for the limit asked for
    const half = [1, 1, 0, 0];
    expect(pairFaces([{ box: face(1, 1), vector: anna }], [{ box: face(2, 2), vector: half }], 0.8)).toEqual([]);
    expect(pairFaces([{ box: face(1, 1), vector: anna }], [{ box: face(2, 2), vector: half }], 0.7)).toHaveLength(1);
  });

  it('uses each face once, the most alike first', () => {
    // two faces of the edit look like Anna; the closer one gets her, and the other stays alone
    const pairs = pairFaces(
      [{ box: face(100, 100), vector: anna }],
      [
        { box: face(10, 10), vector: [0.8, 0.6, 0, 0] },
        { box: face(20, 20), vector: [0.99, 0.1, 0, 0] },
      ],
      0.5,
    );
    expect(pairs).toEqual([{ photo: face(100, 100), edit: face(20, 20) }]);
  });

  it('compares directions, not lengths, and survives an empty vector', () => {
    expect(
      pairFaces([{ box: face(1, 1), vector: [5, 0] }], [{ box: face(2, 2), vector: [0.1, 0] }], 0.99),
    ).toHaveLength(1);
    expect(pairFaces([{ box: face(1, 1), vector: [] }], [{ box: face(2, 2), vector: [1, 0] }], 0)).toHaveLength(1);
    expect(pairFaces([{ box: face(1, 1), vector: [] }], [{ box: face(2, 2), vector: [1, 0] }], 0.1)).toEqual([]);
  });

  it('pairs nothing without faces', () => {
    expect(pairFaces([], [{ box: face(2, 2), vector: anna }], 0.5)).toEqual([]);
    expect(pairFaces([{ box: face(2, 2), vector: anna }], [], 0.5)).toEqual([]);
  });
});

/** A cut around the middle of the photo that stays on it whichever way it is turned, and the size it is saved at. */
const turnedCut = (angle: number) => cut(CAMERA, 2000, 1000, 2400, 1600, angle);
const savedAs = (angle: number) => (isOnItsSide(angle) ? { width: 1600, height: 2400 } : { width: 2400, height: 1600 });
/** The same turn, whichever way round it is written (180 and -180). */
const expectTurn = (placement: Placement, angle: number) => {
  const apart = Math.abs(((placement.angle - angle + 540) % 360) - 180);
  expect(apart).toBeLessThan(1e-6);
};

describe('fitPlacement', () => {
  describe('nothing to place', () => {
    it('has nothing to go by without a face found on both pictures', () => {
      expect(fitPlacement(CAMERA, { width: 3000, height: 3000 }, [])).toEqual({
        placement: null,
        reason: 'no face was found on both pictures',
      });
    });

    it('keeps nothing for the same frame at another resolution', () => {
      for (const edit of [
        { width: 2048, height: 1365 },
        { width: 5568, height: 3712 },
        { width: 12_000, height: 8000 },
      ]) {
        const simulated = simulate({ edit, truth: cut(CAMERA, 0, 0, 6000, 4000), faces: FAMILY });
        expect(fit(simulated)).toEqual({ placement: null, reason: 'the faces are already in place' });
      }
    });

    it('keeps nothing for the same frame when the second detection wobbles', () => {
      for (let seed = 1; seed <= 25; seed++) {
        const simulated = simulate({
          edit: { width: 2048, height: 1365 },
          truth: cut(CAMERA, 0, 0, 6000, 4000),
          faces: FAMILY,
          wobble: 0.04,
          seed,
        });
        expect(fit(simulated), `seed ${seed}`).toEqual({ placement: null, reason: 'the faces are already in place' });
      }
    });

    it('keeps nothing for a trim too small to see', () => {
      // 20 pixels off each side of 6000: a face moves by a twentieth of its own width at most
      const simulated = simulate({
        edit: { width: 5960, height: 3974 },
        truth: cut(CAMERA, 20, 13, 5960, 3974),
        faces: FAMILY,
      });
      expect(fit(simulated)).toEqual({ placement: null, reason: 'the faces are already in place' });
    });
  });

  describe('a plain crop', () => {
    it.each([
      ['one face', [FAMILY[1]]],
      ['two faces', FAMILY.slice(0, 2)],
      ['four faces', FAMILY],
    ])('puts the faces in place: %s', (_, faces) => {
      const truth = cut(CAMERA, 900, 600, 4200, 2800);
      const placement = expectFacesInPlace(simulate({ edit: { width: 4200, height: 2800 }, truth, faces }), 0.95);
      expect(placement.x).toBeCloseTo(truth.x, 3);
      expect(placement.y).toBeCloseTo(truth.y, 3);
      expect(placement.width).toBeCloseTo(truth.width, 3);
      expect(placement.height).toBeCloseTo(truth.height, 3);
      expect(placement.angle).toBeCloseTo(0, 6);
    });

    it('does not care what resolution the crop was saved at', () => {
      const truth = cut(CAMERA, 900, 600, 4200, 2800);
      for (const edit of [
        { width: 2100, height: 1400 },
        { width: 1024, height: 683 },
        { width: 8400, height: 5600 },
      ]) {
        const placement = expectFacesInPlace(simulate({ edit, truth, faces: FAMILY }), 0.95);
        expect(placement.width).toBeCloseTo(truth.width, 2);
      }
    });

    it.each([
      ['a wide cut (16:9)', cut(CAMERA, 400, 900, 5200, 2925), { width: 5200, height: 2925 }],
      ['a square cut', cut(CAMERA, 1000, 300, 3400, 3400), { width: 3400, height: 3400 }],
      ['an upright cut from a landscape photo', cut(CAMERA, 2000, 200, 2400, 3600), { width: 2400, height: 3600 }],
      ['a corner of the photo', cut(CAMERA, 0, 0, 3600, 2400), { width: 3600, height: 2400 }],
      ['a tight cut around two faces', cut(CAMERA, 2100, 900, 2700, 1800), { width: 2700, height: 1800 }],
    ])('puts the faces in place: %s', (_, truth, edit) => {
      const simulated = simulate({ edit, truth, faces: FAMILY });
      expect(simulated.inFrame.length).toBeGreaterThan(0);
      expectFacesInPlace(simulated, 0.95);
    });

    it('works on an upright photo', () => {
      const upright: Size = { width: 4000, height: 6000 };
      const faces = [face(1500, 1800), face(2600, 2300, 360)];
      const truth = cut(upright, 600, 900, 3000, 4500);
      expectFacesInPlace(simulate({ photo: upright, edit: { width: 3000, height: 4500 }, truth, faces }), 0.95);
    });

    it('goes by the faces still in the frame when the crop cuts one out', () => {
      // the cut starts right of the first face
      const truth = cut(CAMERA, 2200, 500, 3600, 2400);
      const simulated = simulate({ edit: { width: 3600, height: 2400 }, truth, faces: FAMILY });
      expect(simulated.inFrame).toHaveLength(3);
      const placement = expectFacesInPlace(simulated, 0.95);
      // and the face that was cut out is placed outside the frame, where Gallery hides it
      const gone = galleryPlaces(placement, CAMERA, simulated.edit, FAMILY[0]);
      expect(gone.x2).toBeLessThan(0);
    });
  });

  describe('a crop that is also straightened', () => {
    it.each([
      [-3, FAMILY],
      [-0.73, FAMILY],
      [2.11, FAMILY],
      [5, FAMILY],
      [10, FAMILY],
      [2.11, FAMILY.slice(0, 2)],
      [-5, FAMILY.slice(1, 3)],
    ])('puts the faces in place when turned by %s degrees', (angle, faces) => {
      const truth = cut(CAMERA, 700, 500, 4500, 3000, angle);
      // Gallery draws a turned box upright from two of its corners: it stays centred on the face, and gets narrower
      // and taller (or the other way round) the further the picture is turned
      const atLeast = Math.abs(angle) > 5 ? 0.7 : 0.8;
      const placement = expectFacesInPlace(
        simulate({ edit: { width: 4500, height: 3000 }, truth, faces }),
        atLeast,
        0.02,
      );
      expect(placement.angle).toBeCloseTo(angle, 4);
      expect(placement.width).toBeCloseTo(truth.width, 4);
      expect(placement.x).toBeCloseTo(truth.x, 4);
      expect(placement.y).toBeCloseTo(truth.y, 4);
    });

    it('cannot tell a turn from one face, and still puts that face in place', () => {
      const truth = cut(CAMERA, 700, 500, 4500, 3000, 4);
      const simulated = simulate({ edit: { width: 4500, height: 3000 }, truth, faces: [FAMILY[1]] });
      const placement = expectFacesInPlace(simulated, 0.95);
      expect(placement.angle).toBe(0);
    });
  });

  describe('an edit turned further, or on its side', () => {
    // three people near the middle, and a cut around them that stays on the photo whichever way it is turned
    const group = [face(2800, 1500, 300), face(3600, 1700, 300), face(3100, 2200, 260)];
    it.each([90, -90, 180])('puts the faces in place on an edit turned by %s degrees', (angle) => {
      const simulated = simulate({ edit: savedAs(angle), truth: turnedCut(angle), faces: group });
      expect(simulated.inFrame).toHaveLength(3);
      const placement = expectFacesInPlace(simulated, 0.95, 0.02);
      expectTurn(placement, angle);
      expect(placement.width).toBeCloseTo(2400 / 6000, 4);
      expect(placement.height).toBeCloseTo(1600 / 4000, 4);
    });

    it('puts the faces in place on the whole photo turned on its side', () => {
      const whole = cut(CAMERA, 0, 0, 6000, 4000, 90);
      const placement = expectFacesInPlace(
        simulate({ edit: { width: 4000, height: 6000 }, truth: whole, faces: FAMILY }),
        0.95,
      );
      expect(placement).toMatchObject({ width: expect.closeTo(1, 4), height: expect.closeTo(1, 4) });
      expectTurn(placement, 90);
    });

    // Gallery draws a turned box upright from two of its corners, so between quarter turns the box loses its shape
    // (at 45 degrees it is a line). Its centre is what is checked here: it stays on the face.
    it.each([25, -40, 60, 135, -115])('centres the boxes on their faces on an edit turned by %s degrees', (angle) => {
      const simulated = simulate({ edit: savedAs(angle), truth: turnedCut(angle), faces: group });
      expect(simulated.inFrame).toHaveLength(3);
      const placement = expectFacesInPlace(simulated, 0, 0.02);
      expectTurn(placement, angle);
    });

    it('still puts the faces in place when the second detection wobbles', () => {
      for (let seed = 1; seed <= 40; seed++) {
        const angle = [90, -90, 180][seed % 3];
        const simulated = simulate({ edit: savedAs(angle), truth: turnedCut(angle), faces: group, wobble: 0.04, seed });
        expectFacesInPlace(simulated, 0.7);
      }
    });
  });

  describe('a second detection that wobbles', () => {
    it.each([
      ['one face', [FAMILY[1]], 0.75],
      ['two faces', FAMILY.slice(0, 2), 0.75],
      ['four faces', FAMILY, 0.75],
    ])('still puts the faces in place: %s', (_, faces, atLeast) => {
      for (let seed = 1; seed <= 40; seed++) {
        const simulated = simulate({
          edit: { width: 2100, height: 1400 },
          truth: cut(CAMERA, 900, 600, 4200, 2800, seed % 2 ? 0 : 1.5),
          faces,
          wobble: 0.04,
          seed,
        });
        expectFacesInPlace(simulated, atLeast);
      }
    });

    it('lands a box that took no part in the fit (one drawn by hand) near its true spot', () => {
      const drawn = face(3600, 2300, 350);
      for (let seed = 1; seed <= 40; seed++) {
        const truth = cut(CAMERA, 900, 600, 4200, 2800);
        const edit = { width: 2100, height: 1400 };
        const simulated = simulate({ edit, truth, faces: FAMILY, wobble: 0.04, seed });
        const placement = expectFacesInPlace(simulated, 0.7);
        const [{ edit: trueSpot }] = simulate({ edit, truth, faces: [drawn] }).inFrame;
        expect(overlap(galleryPlaces(placement, CAMERA, edit, drawn), trueSpot), `seed ${seed}`).toBeGreaterThan(0.7);
      }
    });
  });

  describe('pairs that make no sense', () => {
    it('keeps nothing when the faces do not agree on one placement', () => {
      const simulated = simulate({
        edit: { width: 4200, height: 2800 },
        truth: cut(CAMERA, 900, 600, 4200, 2800),
        faces: FAMILY,
      });
      // one face was "found" two face widths from where the others say it is: a wrong pairing
      const wrong = simulated.pairs[3].edit;
      simulated.pairs[3].edit = { ...wrong, x1: wrong.x1 + 600, x2: wrong.x2 + 600 };
      expect(fit(simulated)).toEqual({ placement: null, reason: 'the faces do not agree on one placement' });
    });

    it('keeps nothing when the edit would show more than the photo has', () => {
      // the faces are half as large and in the middle of the edit: the edit would be twice the photo
      const pairs: FacePair[] = [
        { photo: face(2000, 2000), edit: face(2500, 2000, 200) },
        { photo: face(4000, 2000), edit: face(3500, 2000, 200) },
      ];
      expect(fitPlacement(CAMERA, CAMERA, pairs)).toEqual({
        placement: null,
        reason: 'the edit would show more than the photo has',
      });
    });

    it('allows the edit a sliver past the edge of the photo', () => {
      // an edit made from the RAW, which is a few pixels larger all round than the camera's own JPEG
      const truth = cut(CAMERA, -120, -80, 6240, 4160);
      expectFacesInPlace(simulate({ edit: { width: 6240, height: 4160 }, truth, faces: FAMILY }), 0.95);
    });

    it('keeps nothing for a face without a size', () => {
      const empty: Box = { x1: 100, y1: 100, x2: 100, y2: 100 };
      const result = fitPlacement(CAMERA, { width: 3000, height: 2000 }, [{ photo: empty, edit: face(500, 500) }]);
      expect(result.placement).toBeNull();
    });
  });
});

describe('placeBox', () => {
  it('is what Gallery makes of the edits, for crops, turns and other resolutions', () => {
    const placements: Array<[Placement, Size]> = [
      [cut(CAMERA, 900, 600, 4200, 2800), { width: 4200, height: 2800 }],
      [cut(CAMERA, 900, 600, 4200, 2800), { width: 1050, height: 700 }],
      [cut(CAMERA, 2000, 200, 2400, 3600), { width: 2400, height: 3600 }],
      [cut(CAMERA, 700, 500, 4500, 3000, 3), { width: 4500, height: 3000 }],
      [cut(CAMERA, 700, 500, 4500, 3000, -7.5), { width: 2250, height: 1500 }],
    ];
    for (const [placement, edit] of placements) {
      for (const box of FAMILY) {
        const ours = placeBox(placement, CAMERA, edit, box);
        const gallerys = galleryPlaces(placement, CAMERA, edit, box);
        for (const side of ['x1', 'y1', 'x2', 'y2'] as const) {
          // Gallery cuts its answer to whole pixels of the cut
          expect(Math.abs(ours[side] - gallerys[side]), `${side} of ${JSON.stringify(placement)}`).toBeLessThan(2);
        }
      }
    }
  });

  it('leaves a box where it is for the whole photo, resized with the picture', () => {
    const whole: Placement = { x: 0, y: 0, width: 1, height: 1, angle: 0 };
    expect(placeBox(whole, CAMERA, CAMERA, FAMILY[0])).toEqual(FAMILY[0]);
    const halved = placeBox(whole, CAMERA, { width: 3000, height: 2000 }, FAMILY[0]);
    expect(halved).toEqual({ x1: 650, y1: 600, x2: 850, y2: 800 });
  });
});

describe('placementEdits', () => {
  it('is a crop in the pixels of the photo, with a turn only when there is one', () => {
    expect(placementEdits({ x: 0.15, y: 0.15, width: 0.7, height: 0.7, angle: 0 }, CAMERA)).toEqual([
      { action: 'crop', parameters: { x: 900, y: 600, width: 4200, height: 2800 } },
    ]);
    expect(placementEdits({ x: 0.15, y: 0.15, width: 0.7, height: 0.7, angle: -2.5 }, CAMERA)).toEqual([
      { action: 'crop', parameters: { x: 900, y: 600, width: 4200, height: 2800 } },
      { action: 'rotate', parameters: { angle: -2.5 } },
    ]);
  });

  it('makes a turn of quarter turns, which change the frame, and a rest, which does not', () => {
    const whole = { x: 0, y: 0, width: 1, height: 1 };
    const turns = (angle: number) => placementEdits({ ...whole, angle }, CAMERA).slice(1);
    expect(turns(90)).toEqual([{ action: 'rotate', parameters: { angle: 90 } }]);
    expect(turns(-90)).toEqual([{ action: 'rotate', parameters: { angle: 270 } }]);
    expect(turns(180)).toEqual([{ action: 'rotate', parameters: { angle: 180 } }]);
    expect(turns(-180)).toEqual([{ action: 'rotate', parameters: { angle: 180 } }]);
    expect(turns(92.5)).toEqual([
      { action: 'rotate', parameters: { angle: 90 } },
      { action: 'rotate', parameters: { angle: 2.5 } },
    ]);
    expect(turns(-100)).toEqual([
      { action: 'rotate', parameters: { angle: 270 } },
      { action: 'rotate', parameters: { angle: -10 } },
    ]);
    expect(turns(30)).toEqual([{ action: 'rotate', parameters: { angle: 30 } }]);
    expect(turns(-44)).toEqual([{ action: 'rotate', parameters: { angle: -44 } }]);
  });

  it('takes a box drawn on the edit back to its place on the photo', () => {
    for (const angle of [0, 3, -6, 90, 270]) {
      const placement = cut(CAMERA, 700, 500, 4500, 3000, angle);
      const edits = placementEdits(placement, CAMERA);
      // the frame the edits end in, in the photo's pixels: what the photo is given as its size for the way back
      const { width, height } = getOutputDimensions(edits, CAMERA);
      expect({ width, height }).toEqual(
        isOnItsSide(angle) ? { width: 3000, height: 4500 } : { width: 4500, height: 3000 },
      );
      const preview: Size = isOnItsSide(angle) ? { width: 960, height: 1440 } : { width: 1440, height: 960 };
      // where Gallery shows the face on a preview of the edit
      const shown = galleryPlaces(placement, CAMERA, preview, FAMILY[1]);
      const back = convertFaceBoxToOriginalImageSpace(
        {
          x: shown.x1,
          y: shown.y1,
          width: shown.x2 - shown.x1,
          height: shown.y2 - shown.y1,
          imageWidth: preview.width,
          imageHeight: preview.height,
        },
        // the photo as the drawing is converted from: the cut's own size, and the placement as its edits
        {
          width,
          height,
          edits,
          exifInfo: { exifImageWidth: CAMERA.width, exifImageHeight: CAMERA.height, orientation: '1' },
        },
      );
      expect({ width: back.imageWidth, height: back.imageHeight }).toEqual(CAMERA);
      const returned: Box = { x1: back.topLeft.x, y1: back.topLeft.y, x2: back.bottomRight.x, y2: back.bottomRight.y };
      // a turned box is drawn upright both ways, so it comes back a little larger; its place is the same
      expect(overlap(returned, FAMILY[1]), `turned by ${angle}`).toBeGreaterThan(angle % 90 === 0 ? 0.97 : 0.7);
    }
  });
});

/** A box as Gallery shows it, on a picture of 1000 x 800. */
const shown = (x1: number, y1: number, x2: number, y2: number) => ({
  boundingBoxX1: x1,
  boundingBoxY1: y1,
  boundingBoxX2: x2,
  boundingBoxY2: y2,
  imageWidth: 1000,
  imageHeight: 800,
});

describe('isInPicture', () => {
  it('is true for a box in the picture and false for one that landed outside it', () => {
    expect(isInPicture(shown(400, 300, 500, 400))).toBe(true);
    expect(isInPicture(shown(-300, 300, -200, 400))).toBe(false);
    expect(isInPicture(shown(400, 900, 500, 1000))).toBe(false);
  });

  it('asks for at least half of the box, as Gallery does after a crop in its own editor', () => {
    // the left edge runs through the box: 60% of it is in the picture, then 40%
    expect(isInPicture(shown(-40, 300, 60, 400))).toBe(true);
    expect(isInPicture(shown(-60, 300, 40, 400))).toBe(false);
    // the same at the bottom edge, where the picture is less tall than wide
    expect(isInPicture(shown(400, 740, 500, 840))).toBe(true);
    expect(isInPicture(shown(400, 760, 500, 860))).toBe(false);
  });

  it('agrees with where the edit truly cut, for a face that Gallery places with the fitted placement', () => {
    // the edit keeps the right two thirds of the photo: the first of the family is cut out
    const truth = cut(CAMERA, 2200, 500, 3600, 2400);
    const edit = { width: 3600, height: 2400 };
    const simulated = simulate({ edit, truth, faces: FAMILY });
    const result = fit(simulated);
    for (const box of FAMILY) {
      const placed = transformFaceBoundingBox(
        {
          boundingBoxX1: box.x1,
          boundingBoxY1: box.y1,
          boundingBoxX2: box.x2,
          boundingBoxY2: box.y2,
          imageWidth: CAMERA.width,
          imageHeight: CAMERA.height,
        },
        placementEdits(result.placement!, CAMERA),
        CAMERA,
      );
      const stillThere = simulated.inFrame.some((entry) => entry.photo === box);
      expect(isInPicture(placed)).toBe(stillThere);
    }
  });

  it('leaves a box or a picture without a size as it is', () => {
    expect(isInPicture(shown(5, 5, 5, 5))).toBe(true);
    expect(isInPicture({ ...shown(5, 5, 50, 50), imageWidth: 0, imageHeight: 0 })).toBe(true);
  });
});
