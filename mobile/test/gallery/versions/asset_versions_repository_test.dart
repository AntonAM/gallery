import 'package:background_downloader/background_downloader.dart';
import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/gallery/versions/asset_versions.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockAssetsApi extends Mock implements AssetsApi {}

void main() {
  late _MockAssetsApi api;
  late AssetVersionsRepository repository;

  setUp(() {
    api = _MockAssetsApi();
    repository = AssetVersionsRepository(api);
  });

  AssetVersionResponseDto dto({
    required String id,
    required AssetVersionKind kind,
    required String rule,
    bool shown = false,
  }) => AssetVersionResponseDto(
    id: id,
    kind: kind,
    rule: rule,
    shown: shown,
    source_: null,
    originalFileName: '$id.file',
    originalMimeType: const Optional.present('image/jpeg'),
    fileSizeInByte: 10,
    width: 3,
    height: 2,
    thumbhash: null,
    fileCreatedAt: DateTime.utc(2024),
    // written a month after the shot
    fileModifiedAt: DateTime.utc(2024, 2),
    isOffline: false,
  );

  test('maps the response, keeping the order and the kinds', () async {
    when(() => api.getAssetVersions('photo')).thenAnswer(
      (_) async => AssetVersionsResponseDto(
        assetId: 'photo',
        versions: [
          dto(id: 'edit', kind: AssetVersionKind.edit, rule: 'edit:name', shown: true),
          dto(id: 'photo', kind: AssetVersionKind.original, rule: 'photo'),
          dto(id: 'raw', kind: AssetVersionKind.raw, rule: 'raw:name'),
        ],
      ),
    );

    final result = await repository.getVersions('photo');

    expect(result.versions.map((v) => v.id), ['edit', 'photo', 'raw']);
    expect(result.versions.map((v) => v.shown), [true, false, false]);
    expect(result.versions.map((v) => v.kind), [
      AssetVersionKind.edit,
      AssetVersionKind.original,
      AssetVersionKind.raw,
    ]);
    expect(result.versions.first.originalMimeType, 'image/jpeg');
    // an edit is listed by when it was made, on the phone's clock
    final (made, phoneOffset) = result.versions.first.listed(const Duration(hours: 8));
    expect(made.isAtSameMomentAs(DateTime.utc(2024, 2)), isTrue);
    expect(made.isUtc, isFalse);
    expect(phoneOffset, DateTime.utc(2024, 2).toLocal().timeZoneOffset);
    // any other file by when it was taken, on the camera's clock: the photo's distance from UTC, not the phone's
    for (final version in result.versions.skip(1)) {
      expect(version.listed(const Duration(hours: 8)), (DateTime.utc(2024, 1, 1, 8), const Duration(hours: 8)));
      expect(version.listed(const Duration(hours: -4, minutes: -30)), (
        DateTime.utc(2023, 12, 31, 19, 30),
        const Duration(hours: -4, minutes: -30),
      ));
    }
  });

  test('an empty body reads as no versions', () async {
    when(() => api.getAssetVersions('photo')).thenAnswer((_) async => null);

    final result = await repository.getVersions('photo');

    expect(result.versions, isEmpty);
  });

  group('download', () {
    late Drift db;

    setUpAll(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
      await StoreService.init(storeRepository: StoreRepository(db), listenUpdates: false);
      await Store.put(StoreKey.serverEndpoint, 'https://gallery.example/api');
    });

    tearDownAll(() async {
      await Store.clear();
      await db.close();
    });

    AssetVersion version(String id, String name) =>
        AssetVersion.fromDto(dto(id: id, kind: AssetVersionKind.raw, rule: 'raw:name')..originalFileName = name);

    test('hands the version\'s file to the app\'s image downloads, under its own name', () async {
      final tasks = <DownloadTask>[];
      final downloader = AssetVersionDownloader(
        enqueue: (task) async {
          tasks.add(task);
          return true;
        },
        headers: () => {'x-proxy': 'secret'},
      );

      final accepted = await downloader.download('photo', version('raw', 'PXL_1.RAW-02.ORIGINAL.dng'));

      expect(accepted, isTrue);
      final task = tasks.single;
      expect(task.url, 'https://gallery.example/api/assets/photo/versions/raw/original');
      expect(task.filename, 'PXL_1.RAW-02.ORIGINAL.dng');
      expect(task.headers, {'x-proxy': 'secret'});
      // the group the app saves to the phone's gallery when the download finishes
      expect(task.group, kDownloadGroupImage);
    });

    test('two files of one shot with the same name are written to folders of their own', () async {
      final tasks = <DownloadTask>[];
      final downloader = AssetVersionDownloader(
        enqueue: (task) async {
          tasks.add(task);
          return true;
        },
        headers: () => {},
      );

      await downloader.download('photo', version('original', 'IMG_1.JPG'));
      await downloader.download('photo', version('export', 'IMG_1.JPG'));

      expect(tasks.map((task) => task.filename), ['IMG_1.JPG', 'IMG_1.JPG']);
      expect(tasks[0].directory, isNot(tasks[1].directory));
      expect(tasks[0].directory, isNotEmpty);
    });

    test('a picture\'s address changes when the file is written again', () {
      final first = version('edit', 'IMG_1-edit.jpg');
      final dtoAgain = dto(id: 'edit', kind: AssetVersionKind.edit, rule: 'edit:name')
        ..fileModifiedAt = DateTime.utc(2024, 3);
      final again = AssetVersion.fromDto(dtoAgain);

      expect(
        assetVersionImageUrl('photo', first),
        'https://gallery.example/api/assets/photo/versions/edit/thumbnail'
        '?size=thumbnail&c=${DateTime.utc(2024, 2).millisecondsSinceEpoch}',
      );
      expect(assetVersionImageUrl('photo', again), isNot(assetVersionImageUrl('photo', first)));
      expect(assetVersionImageUrl('photo', first, size: AssetVersionImageSize.preview), contains('size=preview&c='));
    });

    test('the photo\'s own file does not take the task id a download of the photo uses', () async {
      final tasks = <DownloadTask>[];
      final downloader = AssetVersionDownloader(
        enqueue: (task) async {
          tasks.add(task);
          return false;
        },
        headers: () => {},
      );

      final accepted = await downloader.download('photo', version('photo', 'IMG_1.JPG'));

      expect(accepted, isFalse);
      expect(tasks.single.taskId, isNot('photo'));
      expect(tasks.single.url, 'https://gallery.example/api/assets/photo/versions/photo/original');
    });
  });
}
