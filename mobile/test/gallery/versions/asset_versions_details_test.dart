import 'package:background_downloader/background_downloader.dart';
import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/gallery/versions/asset_version_preview.page.dart';
import 'package:immich_mobile/gallery/versions/asset_versions.repository.dart';
import 'package:immich_mobile/gallery/versions/asset_versions_details.widget.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

class _MockAssetVersionsRepository extends Mock implements AssetVersionsRepository {}

const _assetId = 'asset-1';

final _raw = AssetVersion(
  id: 'version-raw',
  kind: AssetVersionKind.raw,
  shown: false,
  rule: 'raw:name',
  source: 'camera',
  originalFileName: 'IMG_0001.DNG',
  originalMimeType: 'image/x-adobe-dng',
  fileSizeInByte: 25 * 1024 * 1024,
  width: 6000,
  height: 4000,
  fileCreatedAt: DateTime.utc(2024, 5, 1, 10, 30),
  isOffline: false,
);

final _edit = AssetVersion(
  id: 'version-edit',
  kind: AssetVersionKind.edit,
  shown: true,
  rule: 'edit:name',
  source: 'lightroom',
  originalFileName: 'IMG_0001-edit.jpg',
  // taken with the others on 1 May, exported on the 9th
  fileCreatedAt: DateTime.utc(2024, 5, 1, 10, 30),
  fileModifiedAt: DateTime.utc(2024, 5, 9, 12),
  isOffline: true,
);

// the photo's own file is a row too, under the photo's id
final _original = AssetVersion(
  id: _assetId,
  kind: AssetVersionKind.original,
  shown: false,
  rule: 'photo',
  source: 'camera',
  originalFileName: 'IMG_0001.JPG',
  fileCreatedAt: DateTime.utc(2024, 5, 1, 10, 30),
  isOffline: false,
);

void main() {
  late Drift db;
  late _MockAssetVersionsRepository repository;
  // the downloads the buttons started, and whether the app's downloader takes them
  late List<DownloadTask> downloads;
  late bool downloaderAccepts;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestUtils.init();
    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db), listenUpdates: false);
  });

  setUp(() async {
    await Store.clear();
    await Store.put(StoreKey.serverEndpoint, 'http://localhost:0');
    repository = _MockAssetVersionsRepository();
    downloads = [];
    downloaderAccepts = true;
  });

  tearDownAll(() async {
    await Store.clear();
    await db.close();
  });

  Override downloaderOverride() => assetVersionDownloaderProvider.overrideWithValue(
    AssetVersionDownloader(
      enqueue: (task) async {
        downloads.add(task);
        return downloaderAccepts;
      },
      headers: () => {},
    ),
  );

  Future<void> pumpSection(WidgetTester tester, {BaseAsset? asset, ExifInfo? exifInfo}) async {
    await tester.pumpConsumerWidget(
      SingleChildScrollView(
        child: AssetVersionsDetails(
          asset: asset ?? TestUtils.createRemoteAsset(id: _assetId),
          exifInfo: exifInfo,
        ),
      ),
      overrides: [assetVersionsRepositoryProvider.overrideWithValue(repository), downloaderOverride()],
    );
    await tester.pumpAndSettle();
  }

  /// The message the app shows stays for three seconds on a timer of its own: wait it out before the test ends.
  Future<void> settleToast(WidgetTester tester) async {
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
  }

  Finder versionRow(String id) => find.byKey(ValueKey('asset-version-$id'));

  testWidgets('an error (an older server answers 404) shows nothing', (tester) async {
    when(() => repository.getVersions(_assetId)).thenThrow(Exception('404'));

    await pumpSection(tester);

    expect(find.byType(AssetVersionTile), findsNothing);
    expect(find.text('Versions'), findsNothing);
    expect(find.text('Could not load the versions of this photo'), findsNothing);
  });

  testWidgets('a photo without versions shows nothing', (tester) async {
    when(() => repository.getVersions(_assetId)).thenAnswer((_) async => AssetVersions.empty);

    await pumpSection(tester);

    expect(find.byType(AssetVersionTile), findsNothing);
    expect(find.text('Versions'), findsNothing);
  });

  testWidgets('a video is not asked for versions', (tester) async {
    final video = TestUtils.createRemoteAsset(id: _assetId).copyWith(type: AssetType.video);

    await pumpSection(tester, asset: video);

    verifyNever(() => repository.getVersions(any()));
    expect(find.byType(AssetVersionTile), findsNothing);
  });

  testWidgets('shows each file behind the photo with its kind and details, and nothing that changes them', (
    tester,
  ) async {
    when(
      () => repository.getVersions(_assetId),
    ).thenAnswer((_) async => AssetVersions(versions: [_edit, _original, _raw]));

    await pumpSection(tester);

    expect(find.text('Versions'), findsOneWidget);
    expect(find.text('3 versions'), findsOneWidget);
    expect(versionRow(_edit.id), findsOneWidget);
    expect(versionRow(_original.id), findsOneWidget);
    expect(versionRow(_raw.id), findsOneWidget);

    expect(find.text('IMG_0001.DNG'), findsOneWidget);
    expect(find.text('RAW'), findsOneWidget);
    expect(find.text('Original'), findsOneWidget);
    expect(find.text('Edit'), findsOneWidget);
    expect(find.textContaining('DNG · 25.0 MiB · 6000 × 4000'), findsOneWidget);
    expect(find.text('Offline'), findsOneWidget);
    // the edit shows the day it was made, the other two the day the photo was taken
    expect(find.textContaining('May 9, 2024'), findsOneWidget);
    expect(find.textContaining('May 1, 2024'), findsNWidgets(2));
    // the file the photo's picture comes from is marked, and only that one
    expect(find.text('Shown'), findsOneWidget);
    expect(find.byKey(ValueKey('asset-version-shown-${_edit.id}')), findsOneWidget);

    final thumbnail = tester.widget<Image>(find.descendant(of: versionRow(_raw.id), matching: find.byType(Image)));
    expect(
      (thumbnail.image as RemoteImageProvider).url,
      // with when the file was last written, so a file written again is not shown from the app's cache
      'http://localhost:0/assets/$_assetId/versions/${_raw.id}/thumbnail'
      '?size=thumbnail&c=${_raw.fileModifiedAt?.millisecondsSinceEpoch ?? 0}',
    );

    // Gallery arranges versions itself: no menu, nothing that changes them
    expect(find.byType(PopupMenuButton<void>), findsNothing);
    expect(find.text('Make it a separate photo'), findsNothing);
  });

  testWidgets('shows capture times on the camera\'s clock with its time zone, and an edit\'s time on the phone\'s', (
    tester,
  ) async {
    when(
      () => repository.getVersions(_assetId),
    ).thenAnswer((_) async => AssetVersions(versions: [_edit, _original, _raw]));

    // the photo was taken eight hours ahead of UTC, wherever the phone is now
    await pumpSection(
      tester,
      exifInfo: ExifInfo(dateTimeOriginal: DateTime.utc(2024, 5, 1, 10, 30), timeZone: 'UTC+08:00'),
    );

    // taken at 10:30 UTC: 18:30 on the camera's clock, for the camera's file and the RAW
    expect(find.textContaining('GMT+08:00'), findsNWidgets(2));
    expect(find.textContaining(RegExp(r'May 1, 2024.*6:30.*GMT\+08:00$')), findsNWidgets(2));
    // the edit was made on 9 May at 12:00 UTC: shown on the phone's clock, with the phone's zone
    final onThePhone = DateTime.utc(2024, 5, 9, 12).toLocal();
    expect(
      find.descendant(
        of: versionRow(_edit.id),
        matching: find.textContaining('GMT${onThePhone.timeZoneOffset.formatAsOffset()}'),
      ),
      findsOneWidget,
    );
    expect(find.descendant(of: versionRow(_edit.id), matching: find.textContaining('May 9, 2024')), findsOneWidget);
  });

  Finder downloadButton(String id) => find.byKey(ValueKey('asset-version-download-$id'));

  testWidgets('downloads a version\'s file from its row and says so, and offers none for an offline file', (
    tester,
  ) async {
    when(
      () => repository.getVersions(_assetId),
    ).thenAnswer((_) async => AssetVersions(versions: [_edit, _original, _raw]));
    await pumpSection(tester);

    // the edit is offline: the server could not send it
    expect(downloadButton(_edit.id), findsNothing);
    expect(downloadButton(_original.id), findsOneWidget);

    await tester.tap(downloadButton(_raw.id));
    await tester.pumpAndSettle();

    expect(downloads.single.url, 'http://localhost:0/assets/$_assetId/versions/${_raw.id}/original');
    expect(downloads.single.filename, 'IMG_0001.DNG');
    expect(find.text('Downloading IMG_0001.DNG'), findsOneWidget);
    // the download does not open the version
    expect(find.byType(AssetVersionPreviewPage), findsNothing);

    await settleToast(tester);
  });

  testWidgets('says that a download did not start', (tester) async {
    when(() => repository.getVersions(_assetId)).thenAnswer((_) async => AssetVersions(versions: [_original, _raw]));
    downloaderAccepts = false;
    await pumpSection(tester);

    await tester.tap(downloadButton(_raw.id));
    await tester.pumpAndSettle();

    expect(downloads, hasLength(1));
    expect(find.text('Download failed'), findsOneWidget);
    expect(find.textContaining('Downloading'), findsNothing);

    await settleToast(tester);
  });

  testWidgets('downloads from the full-screen view of a version too', (tester) async {
    // the picture never loads in a test, so its spinner never settles: pump by hand
    await tester.pumpConsumerWidgetRaw(
      AssetVersionPreviewPage(assetId: _assetId, version: _raw),
      overrides: [downloaderOverride()],
    );
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey('asset-version-preview-download')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(downloads.single.url, 'http://localhost:0/assets/$_assetId/versions/${_raw.id}/original');
    expect(find.text('Downloading IMG_0001.DNG'), findsOneWidget);

    // past the message's three seconds
    await tester.pump(const Duration(seconds: 4));
    await tester.pump(const Duration(seconds: 1));
  });
}
