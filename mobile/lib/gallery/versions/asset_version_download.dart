import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/gallery/versions/asset_versions.repository.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

final _log = Logger('AssetVersionDownload');

/// Starts the download of a version's file to the phone and says so. From there it is one of the app's downloads:
/// the app shows its progress and saves the finished file to the phone's gallery.
Future<void> downloadAssetVersion(BuildContext context, WidgetRef ref, String assetId, AssetVersion version) async {
  var accepted = false;
  try {
    accepted = await ref.read(assetVersionDownloaderProvider).download(assetId, version);
  } catch (error, stack) {
    // reported below, as a download that did not start
    _log.warning('Could not start the download of version ${version.id}', error, stack);
  }
  if (!context.mounted) {
    return;
  }
  ImmichToast.show(
    context: context,
    msg: accepted ? context.t.downloading_filename(filename: version.originalFileName) : context.t.download_failed,
    toastType: accepted ? ToastType.info : ToastType.error,
  );
}
