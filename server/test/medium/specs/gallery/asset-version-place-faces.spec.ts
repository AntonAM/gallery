import { Kysely } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AssetVersionRepository } from 'src/gallery/repositories/asset-version.repository.js';
import { AssetVersionService } from 'src/gallery/services/asset-version.service.js';
import { overlap, type Box } from 'src/gallery/utils/asset-version-face-placement.js';
import { inShownPicture, shownEditAsset, shownEdits } from 'src/gallery/utils/asset-version-look.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { convertFaceBoxToOriginalImageSpace } from 'src/utils/asset.util.js';
import { clearConfigCache } from 'src/utils/config.js';
import { transformFaceBoundingBox } from 'src/utils/transform.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// The job that puts a photo's face boxes where the faces are on the edit it shows (asset-version.service.ts,
// `handlePlaceFaces`), on a real database. Only the face detector is a stand-in: it "finds" on the edit's preview
// what the test says. The arithmetic itself is tested case by case in asset-version-face-placement.spec.ts.

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const setup = ({ facialRecognition = true }: { facialRecognition?: boolean } = {}) => {
  clearConfigCache();
  const { sut, ctx } = newMediumService(AssetVersionService, {
    database: defaultDatabase,
    real: [AssetRepository, AssetVersionRepository, ConfigRepository, PersonRepository],
    mock: [EventRepository, JobRepository, LoggingRepository, MachineLearningRepository, SystemMetadataRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(SystemMetadataRepository).get.mockImplementation((key) => {
    if (key === SystemMetadataKey.SystemConfig) {
      return {
        server: { assetVersions: { enabled: true, detectEdits: true } },
        machineLearning: { facialRecognition: { enabled: facialRecognition } },
      } as never;
    }
    return undefined as never;
  });
  return { sut, ctx, detector: ctx.getMock(MachineLearningRepository).detectFaces };
};

/** The photo's own frame, and the preview its faces were found on. */
const CAMERA = { width: 6000, height: 4000 };
const PREVIEW = { width: 1440, height: 960 };
const EDITED_PREVIEW = '/thumbs/photo-preview-edited.jpeg';

/** A recognition vector for the person of this number: nothing like any other person's. */
const vectorOf = (person: number, tilt = 0) => {
  const vector = Array.from({ length: 512 }, () => 0);
  vector[person] = 1;
  vector[511] = tilt; // the same person, seen a little differently
  return `[${vector.join(',')}]`;
};

/** A square box of this size around a point. */
const around = (x: number, y: number, size: number): Box => ({
  x1: x - size / 2,
  y1: y - size / 2,
  x2: x + size / 2,
  y2: y + size / 2,
});

/** Where the three people are on the photo, in the photo's own pixels. */
const ON_THE_PHOTO: Box[] = [around(1500, 1400, 400), around(3000, 1700, 460), around(4300, 1500, 380)];

/**
A photo (6000×4000) that shows an edit of this resolution, with its three faces found on the photo's own preview.
Returns the ids of the photo and of each face.
*/
const photoShowingAnEdit = async (ctx: MediumTestContext, edit: { width: number; height: number }) => {
  const { user } = await ctx.newUser();
  const { asset: photo } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'DSC_70.JPG' });
  await ctx.newExif({
    assetId: photo.id,
    exifImageWidth: CAMERA.width,
    exifImageHeight: CAMERA.height,
    orientation: '1',
  });
  const modifiedAt = new Date('2026-10-01T10:00:00.000Z');
  const { asset: source } = await ctx.newAsset({
    ownerId: user.id,
    originalFileName: 'DSC_70-Edit.jpg',
    fileModifiedAt: modifiedAt,
  });
  await ctx.get(AssetVersionRepository).setLook(photo.id, { id: source.id, modifiedAt }, edit);
  await ctx.newAssetFile({ assetId: photo.id, type: AssetFileType.Preview, path: EDITED_PREVIEW, isEdited: true });

  const faceIds: string[] = [];
  for (const [person, box] of ON_THE_PHOTO.entries()) {
    const toPreview = PREVIEW.width / CAMERA.width;
    const { result: faceId } = await ctx.newAssetFace({
      assetId: photo.id,
      imageWidth: PREVIEW.width,
      imageHeight: PREVIEW.height,
      boundingBoxX1: Math.round(box.x1 * toPreview),
      boundingBoxY1: Math.round(box.y1 * toPreview),
      boundingBoxX2: Math.round(box.x2 * toPreview),
      boundingBoxY2: Math.round(box.y2 * toPreview),
    });
    await defaultDatabase
      .insertInto('face_search')
      .values({ faceId, embedding: vectorOf(person) })
      .execute();
    faceIds.push(faceId);
  }
  return { photoId: photo.id, sourceId: source.id, modifiedAt, faceIds, ownerId: user.id };
};

/**
What the detector finds on a preview (1440 wide) of an edit cut out of the photo at `cut` (the photo's pixels):
each person still in the frame, at the same spot of the scene, as much larger as the picture became.
*/
const foundOnTheEdit = (cut: { x: number; y: number; width: number; height: number }) => {
  const preview = { width: 1440, height: Math.round((1440 * cut.height) / cut.width) };
  const larger = preview.width / cut.width;
  const faces = ON_THE_PHOTO.flatMap((box, person) => {
    const x = ((box.x1 + box.x2) / 2 - cut.x) * larger;
    const y = ((box.y1 + box.y2) / 2 - cut.y) * larger;
    if (x < 0 || y < 0 || x > preview.width || y > preview.height) {
      return [];
    }
    const boundingBox = around(x, y, (box.x2 - box.x1) * larger);
    return { boundingBox, embedding: vectorOf(person, 0.2), score: 0.9, person };
  });
  return { imageWidth: preview.width, imageHeight: preview.height, faces };
};

const lookOf = (photoId: string) =>
  defaultDatabase
    .selectFrom('asset_version')
    .select(['placement', 'lookSourceAssetId as sourceAssetId'])
    .where('versionAssetId', '=', photoId)
    .where('role', '=', 'base_photo')
    .where('lookUpdatedAt', 'is not', null)
    .executeTakeFirstOrThrow();

const placementOf = async (photoId: string) => {
  const look = await lookOf(photoId);
  return look.placement;
};

const done = (name: JobName, id: string, response: JobStatus) => ({ job: { name, data: { id } }, response }) as never;

/** Whether each face of the photo shows, in no particular order. */
const visibilities = async (photoId: string) => {
  const faces = await visibleFaces(photoId);
  return faces.values().toArray();
};

const visibleFaces = async (photoId: string) => {
  const rows = await defaultDatabase
    .selectFrom('asset_face')
    .select(['id', 'isVisible'])
    .where('assetId', '=', photoId)
    .execute();
  return new Map(rows.map((row) => [row.id, row.isVisible]));
};

/** Where Gallery shows a stored face of the photo, as a share (0–1) of the picture the photo shows. */
const shownAt = async (ctx: MediumTestContext, photoId: string, faceId: string) => {
  const face = await defaultDatabase
    .selectFrom('asset_face')
    .selectAll()
    .where('id', '=', faceId)
    .executeTakeFirstOrThrow();
  const edits = await shownEdits(ctx.get(AssetVersionRepository), photoId, [], CAMERA);
  const placed = transformFaceBoundingBox(face, edits, CAMERA);
  return {
    x1: placed.boundingBoxX1 / placed.imageWidth,
    y1: placed.boundingBoxY1 / placed.imageHeight,
    x2: placed.boundingBoxX2 / placed.imageWidth,
    y2: placed.boundingBoxY2 / placed.imageHeight,
  };
};

const asShare = (box: Box, picture: { imageWidth: number; imageHeight: number }): Box => ({
  x1: box.x1 / picture.imageWidth,
  y1: box.y1 / picture.imageHeight,
  x2: box.x2 / picture.imageWidth,
  y2: box.y2 / picture.imageHeight,
});

describe('AssetVersionService: face boxes on a photo that shows an edit', () => {
  describe('a cropped edit', () => {
    // the edit keeps the right two thirds of the photo: the first person is cut out
    const cut = { x: 2200, y: 500, width: 3600, height: 2400 };

    it('finds the faces on the edit’s preview, stores where the edit sits on the photo, and Gallery then shows each face where it was found', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId, faceIds } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      const found = foundOnTheEdit(cut);
      detector.mockResolvedValue(found);

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);

      expect(detector).toHaveBeenCalledTimes(1);
      // the same low-level call the face job makes, on the edited preview; a find may be half as sure as the face
      // job asks for (0.7 by default), since only a face recognised as one of the photo's is used
      expect(detector).toHaveBeenCalledWith(
        EDITED_PREVIEW,
        expect.objectContaining({ modelName: 'buffalo_l', minScore: 0.35, maxDistance: 0.5 }),
      );

      const { placement } = await lookOf(photoId);
      expect(placement).not.toBeNull();
      expect(placement!.x).toBeCloseTo(cut.x / CAMERA.width, 2);
      expect(placement!.y).toBeCloseTo(cut.y / CAMERA.height, 2);
      expect(placement!.width).toBeCloseTo(cut.width / CAMERA.width, 2);
      expect(placement!.height).toBeCloseTo(cut.height / CAMERA.height, 2);
      expect(Math.abs(placement!.angle)).toBeLessThan(0.5);

      // the goal: each face still in the frame is shown where the second detection found it
      expect(found.faces.map((face) => face.person)).toEqual([1, 2]);
      for (const face of found.faces) {
        const shown = await shownAt(ctx, photoId, faceIds[face.person]);
        expect(overlap(shown, asShare(face.boundingBox, found)), `person ${face.person}`).toBeGreaterThan(0.9);
      }
    });

    it('gives the face the edit cut out no box, and changes nothing about it', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId, faceIds } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockResolvedValue(foundOnTheEdit(cut));

      await sut.handlePlaceFaces({ id: photoId });

      // every face is still on the photo, visible: nobody leaves a person's list, and no person is left faceless
      expect(await visibilities(photoId)).toEqual([true, true, true]);
      // what the web is given to draw: the two faces in the picture, not the one that was cut out
      const repository = ctx.get(AssetVersionRepository);
      const edits = await shownEdits(repository, photoId, [], CAMERA);
      const faces = await defaultDatabase.selectFrom('asset_face').selectAll().where('assetId', '=', photoId).execute();
      const drawn = inShownPicture(
        faces.map((face) => ({ id: face.id, ...transformFaceBoundingBox(face, edits, CAMERA) })),
        [],
        edits,
      );
      expect(drawn.map(({ id }) => id).toSorted()).toEqual([faceIds[1], faceIds[2]].toSorted());

      // found again, and now the picture shows the whole frame, only smaller: every face has its box
      detector.mockResolvedValue(foundOnTheEdit({ x: 0, y: 0, ...CAMERA }));
      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      expect(await placementOf(photoId)).toBeNull();
      const whole = await shownEdits(repository, photoId, [], CAMERA);
      expect(
        inShownPicture(
          faces.map((face) => transformFaceBoundingBox(face, whole, CAMERA)),
          [],
          whole,
        ),
      ).toHaveLength(3);
    });

    it('forgets the placement when the picture is rendered again', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId, sourceId, modifiedAt } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockResolvedValue(foundOnTheEdit(cut));
      await sut.handlePlaceFaces({ id: photoId });
      expect(await placementOf(photoId)).not.toBeNull();

      await ctx
        .get(AssetVersionRepository)
        .setLook(photoId, { id: sourceId, modifiedAt }, { width: 3600, height: 2400 });
      expect(await placementOf(photoId)).toBeNull();
    });

    it('leaves a picture that was rendered again while the faces were being found to its own job', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId, sourceId } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockImplementation(async () => {
        // the edit is exported again over itself, and rendered, while the detector is at work
        const later = new Date('2026-10-02T10:00:00.000Z');
        await ctx
          .get(AssetVersionRepository)
          .setLook(photoId, { id: sourceId, modifiedAt: later }, { width: 3000, height: 3000 });
        return foundOnTheEdit(cut);
      });

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Skipped);
      expect(await placementOf(photoId)).toBeNull();
    });

    it('leaves it alone too when it was rendered again from the same file, unchanged', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId, sourceId, modifiedAt } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockImplementation(async () => {
        // "Regenerate thumbnail": the same file, the same date, a new render
        await ctx
          .get(AssetVersionRepository)
          .setLook(photoId, { id: sourceId, modifiedAt }, { width: 3600, height: 2400 });
        return foundOnTheEdit(cut);
      });

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Skipped);
      expect(await placementOf(photoId)).toBeNull();
    });

    it('takes a box drawn by hand on the edit back to its place on the photo', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockResolvedValue(foundOnTheEdit(cut));
      await sut.handlePlaceFaces({ id: photoId });

      // drawn on a 1440-wide preview of the edit, around the spot that is (3700, 2300) on the photo
      const drawn = around((3700 - cut.x) * 0.4, (2300 - cut.y) * 0.4, 120);
      const asset = await ctx.get(AssetRepository).getById(photoId, { edits: true, exifInfo: true });
      const drawnOn = await shownEditAsset(ctx.get(AssetVersionRepository), asset!);
      const back = convertFaceBoxToOriginalImageSpace(
        { x: drawn.x1, y: drawn.y1, width: 120, height: 120, imageWidth: 1440, imageHeight: 960 },
        drawnOn,
      );
      expect({ width: back.imageWidth, height: back.imageHeight }).toEqual(CAMERA);
      const onThePhoto: Box = {
        x1: back.topLeft.x,
        y1: back.topLeft.y,
        x2: back.bottomRight.x,
        y2: back.bottomRight.y,
      };
      expect(overlap(onThePhoto, around(3700, 2300, 300))).toBeGreaterThan(0.9);
    });
  });

  describe('nothing to do', () => {
    it('places the faces on a crop exported at the size of the photo: the same size is no proof of the same frame', async () => {
      const { sut, ctx, detector } = setup();
      const cut = { x: 2200, y: 500, width: 3600, height: 2400 };
      // cropped, then enlarged back to the camera's resolution on export
      const { photoId } = await photoShowingAnEdit(ctx, { width: 6000, height: 4000 });
      detector.mockResolvedValue(foundOnTheEdit(cut));

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      const placement = await placementOf(photoId);
      expect(placement!.x).toBeCloseTo(cut.x / CAMERA.width, 2);
      expect(placement!.width).toBeCloseTo(cut.width / CAMERA.width, 2);
    });

    it('stores nothing for an edit of the photo’s size that shows the same frame', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: 6000, height: 3996 });
      detector.mockResolvedValue(foundOnTheEdit({ x: 0, y: 0, ...CAMERA }));

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      expect(detector).toHaveBeenCalledTimes(1);
      expect(await placementOf(photoId)).toBeNull();
    });

    it('does not look for faces on the edit of a photo that has none', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: 3600, height: 2400 });
      await defaultDatabase.deleteFrom('asset_face').where('assetId', '=', photoId).execute();

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      expect(detector).not.toHaveBeenCalled();
      expect(await placementOf(photoId)).toBeNull();
    });

    it('stores nothing for an edit that is the same frame at another resolution', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: 2048, height: 1365 });
      detector.mockResolvedValue(foundOnTheEdit({ x: 0, y: 0, ...CAMERA }));

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      expect(detector).toHaveBeenCalledTimes(1);
      expect(await placementOf(photoId)).toBeNull();
      expect(await visibilities(photoId)).toEqual([true, true, true]);
    });

    it('stores nothing when the faces on the edit are other people', async () => {
      const { sut, ctx, detector } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: 3600, height: 2400 });
      detector.mockResolvedValue({
        imageWidth: 1440,
        imageHeight: 960,
        faces: [{ boundingBox: around(700, 500, 150), embedding: vectorOf(40), score: 0.9 }],
      });

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Success);
      expect(await placementOf(photoId)).toBeNull();
    });

    it('is skipped while face recognition is off', async () => {
      const { sut, ctx, detector } = setup({ facialRecognition: false });
      const { photoId } = await photoShowingAnEdit(ctx, { width: 3600, height: 2400 });

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Skipped);
      expect(detector).not.toHaveBeenCalled();
    });

    it('is skipped for a photo that shows its own file', async () => {
      const { sut, ctx, detector } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.handlePlaceFaces({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(detector).not.toHaveBeenCalled();
    });
  });

  describe('a photo that Gallery’s own editor has cropped', () => {
    it('is left alone: its picture is made from its own file, and its boxes go by its own edits', async () => {
      const { sut, ctx, detector } = setup();
      const cut = { x: 2200, y: 500, width: 3600, height: 2400 };
      const { photoId, faceIds } = await photoShowingAnEdit(ctx, { width: cut.width, height: cut.height });
      detector.mockResolvedValue(foundOnTheEdit(cut));
      await sut.handlePlaceFaces({ id: photoId });
      expect(await placementOf(photoId)).not.toBeNull();
      detector.mockClear();

      const ownCrop = { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 3000, height: 2000 } } as const;
      await ctx.newEdits(photoId, { edits: [ownCrop] });

      await expect(sut.handlePlaceFaces({ id: photoId })).resolves.toBe(JobStatus.Skipped);
      expect(detector).not.toHaveBeenCalled();
      // the stored placement is not what shows, so it is not what boxes go through
      const repository = ctx.get(AssetVersionRepository);
      expect(await repository.getShownPlacement(photoId)).toBeNull();
      expect(await shownEdits(repository, photoId, [ownCrop], CAMERA)).toEqual([ownCrop]);
      expect(faceIds).toHaveLength(3);
    });
  });

  describe('when the job is queued', () => {
    it('after the picture of a photo with a look is rendered, and after its faces are found', async () => {
      const { sut, ctx } = setup();
      const { photoId } = await photoShowingAnEdit(ctx, { width: 3600, height: 2400 });
      const queue = ctx.getMock(JobRepository).queue;
      const placeFaces = { name: JobName.AssetVersionPlaceFaces, data: { id: photoId } };

      await sut.onJobSuccess(done(JobName.AssetDetectFaces, photoId, JobStatus.Success));
      expect(queue).toHaveBeenCalledWith(placeFaces);
      queue.mockClear();

      await sut.onJobSuccess(done(JobName.AssetEditThumbnailGeneration, photoId, JobStatus.Success));
      expect(queue).toHaveBeenCalledWith(placeFaces);
      queue.mockClear();

      // "Regenerate thumbnail" renders the picture from the edit too
      await sut.onJobSuccess(done(JobName.AssetGenerateThumbnails, photoId, JobStatus.Success));
      expect(queue).toHaveBeenCalledWith(placeFaces);
    });

    it('not for a photo that shows its own file, and not after a job that did nothing', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { photoId } = await photoShowingAnEdit(ctx, { width: 3600, height: 2400 });
      const queue = ctx.getMock(JobRepository).queue;

      await sut.onJobSuccess(done(JobName.AssetDetectFaces, plain.id, JobStatus.Success));
      await sut.onJobSuccess(done(JobName.AssetDetectFaces, photoId, JobStatus.Skipped));
      await sut.onJobSuccess(done(JobName.AssetDetectFaces, photoId, JobStatus.Failed));
      await sut.onJobSuccess(done(JobName.AssetEditThumbnailGeneration, photoId, JobStatus.Failed));
      await sut.onJobSuccess(done(JobName.AssetGenerateThumbnails, plain.id, JobStatus.Success));
      await sut.onJobSuccess(done(JobName.AssetGenerateThumbnails, photoId, JobStatus.Failed));
      await sut.onJobSuccess(done(JobName.SmartSearch, photoId, JobStatus.Success));

      expect(queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetVersionPlaceFaces }));
    });
  });
});
