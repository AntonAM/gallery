import 'package:background_downloader/background_downloader.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/download.provider.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:openapi/api.dart';

/// One file of a photo's shot (`specs/2026-11-07-asset-versions-design.md`): a hidden asset behind the photo (an
/// edit, the camera's own file, the RAW), reached only through the photo, or the photo's own file, under its id.
class AssetVersion {
  const AssetVersion({
    required this.id,
    required this.kind,
    required this.shown,
    required this.rule,
    required this.originalFileName,
    required this.fileCreatedAt,
    required this.isOffline,
    this.fileModifiedAt,
    this.source,
    this.originalMimeType,
    this.fileSizeInByte,
    this.width,
    this.height,
  });

  final String id;

  /// The RAW, the camera's own file behind an edit, or an older edit.
  final AssetVersionKind kind;

  /// The photo's picture comes from this file.
  final bool shown;

  /// The detection rule that paired it (`raw:name`, `edit:name`, `edit:time`).
  final String rule;
  final String? source;
  final String originalFileName;
  final String? originalMimeType;
  final int? fileSizeInByte;
  final int? width;
  final int? height;
  final DateTime fileCreatedAt;

  /// When the file was last written: for an edit, when it was made. The newest edit is the one shown.
  final DateTime? fileModifiedAt;
  final bool isOffline;

  /// The time the list shows for this file, and the distance from UTC it is shown at. An edit: when it was made, on
  /// the phone's clock. Any other file: when it was taken, on the camera's clock, as the details sheet shows the
  /// photo's time ([cameraOffset] is the photo's own distance from UTC). The files of one shot were taken in the
  /// same moment, so the photo's distance is theirs too.
  (DateTime, Duration) listed(Duration cameraOffset) {
    final made = kind == AssetVersionKind.edit ? fileModifiedAt : null;
    if (made != null) {
      final onThePhone = made.toLocal();
      return (onThePhone, onThePhone.timeZoneOffset);
    }
    return (fileCreatedAt.toUtc().add(cameraOffset), cameraOffset);
  }

  factory AssetVersion.fromDto(AssetVersionResponseDto dto) => AssetVersion(
    id: dto.id,
    kind: dto.kind,
    shown: dto.shown,
    rule: dto.rule,
    source: dto.source_,
    originalFileName: dto.originalFileName,
    originalMimeType: dto.originalMimeType.orElse(null),
    fileSizeInByte: dto.fileSizeInByte,
    width: dto.width,
    height: dto.height,
    fileCreatedAt: dto.fileCreatedAt,
    fileModifiedAt: dto.fileModifiedAt,
    isOffline: dto.isOffline,
  );
}

/// The files of a photo's shot, its own file included, as the server orders them: edits newest first, then the
/// original, then the RAW. Gallery arranges them itself; the app only shows them.
class AssetVersions {
  const AssetVersions({required this.versions});

  static const empty = AssetVersions(versions: []);

  final List<AssetVersion> versions;
}

/// Versions are fetched when the details sheet opens: there is no sync stream and no Drift table for them.
class AssetVersionsRepository {
  const AssetVersionsRepository(this._api);

  final AssetsApi _api;

  /// `GET /assets/{id}/versions`. Throws on any failure, including the 404 of a server that predates versions; the
  /// section reads an error as "no versions".
  Future<AssetVersions> getVersions(String assetId) async {
    final dto = await _api.getAssetVersions(assetId);
    if (dto == null) {
      return AssetVersions.empty;
    }
    return AssetVersions(versions: dto.versions.map(AssetVersion.fromDto).toList());
  }
}

final assetVersionsRepositoryProvider = Provider<AssetVersionsRepository>(
  (ref) => AssetVersionsRepository(ref.watch(apiServiceProvider).assetsApi),
);

/// The versions of one photo, by its remote asset id.
final assetVersionsProvider = FutureProvider.autoDispose.family<AssetVersions, String>(
  (ref, assetId) => ref.watch(assetVersionsRepositoryProvider).getVersions(assetId),
);

/// The version's image (`thumbnail` or `preview`), loaded with the app's authenticated remote image providers. The
/// address carries when the file was last written (`c`, as the web's does its thumbhash): a file exported again over
/// itself keeps its id, and the picture the app has kept for the old address must not be shown for the new file.
String assetVersionImageUrl(
  String assetId,
  AssetVersion version, {
  AssetVersionImageSize size = AssetVersionImageSize.thumbnail,
}) =>
    '${Store.get(StoreKey.serverEndpoint)}/assets/$assetId/versions/${version.id}/thumbnail'
    '?size=${size.toJson()}&c=${version.fileModifiedAt?.millisecondsSinceEpoch ?? 0}';

/// The version's file as it was uploaded (`GET /assets/{id}/versions/{versionId}/original`).
String assetVersionOriginalUrl(String assetId, String versionId) =>
    '${Store.get(StoreKey.serverEndpoint)}/assets/$assetId/versions/$versionId/original';

/// Downloads a version's file to the phone with the app's own downloader. The task goes into the app's image group,
/// so the app treats it like a downloaded photo: it shows the progress and saves the finished file to the phone's
/// gallery. A file that is on the phone already is saved a second time.
class AssetVersionDownloader {
  const AssetVersionDownloader({required this.enqueue, required this.headers});

  final Future<bool> Function(DownloadTask task) enqueue;

  /// The headers the user set for the server; the login is added to every call to the server by the app itself.
  final Map<String, String> Function() headers;

  /// Whether the download was accepted.
  Future<bool> download(String assetId, AssetVersion version) => enqueue(
    DownloadTask(
      // not the bare id: the photo's own file is listed under the photo's id, which a download of the photo uses
      taskId: 'version-${version.id}',
      url: assetVersionOriginalUrl(assetId, version.id),
      headers: headers(),
      filename: version.originalFileName,
      // a folder of its own: two files of one shot can have the same name, and would otherwise be written to, and
      // cleaned up from, the same place while both are on their way
      directory: 'version-${version.id}',
      updates: Updates.statusAndProgress,
      group: kDownloadGroupImage,
    ),
  );
}

final assetVersionDownloaderProvider = Provider<AssetVersionDownloader>((ref) {
  // the app's download state listens to the image group: it is what saves the finished file to the gallery
  ref.watch(downloadStateProvider);
  return AssetVersionDownloader(enqueue: FileDownloader().enqueue, headers: ApiService.getRequestHeaders);
});
