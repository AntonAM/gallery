import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/gallery/versions/asset_version_download.dart';
import 'package:immich_mobile/gallery/versions/asset_versions.repository.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:openapi/api.dart' show AssetVersionImageSize;

/// A version shown full screen: its `preview` image, zoomable, with its download. A version is reached only through
/// its photo, so it has no page of its own in the asset viewer.
class AssetVersionPreviewPage extends ConsumerWidget {
  const AssetVersionPreviewPage({super.key, required this.assetId, required this.version});

  final String assetId;
  final AssetVersion version;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(version.originalFileName, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (!version.isOffline)
            IconButton(
              key: const ValueKey('asset-version-preview-download'),
              icon: const Icon(Icons.download_outlined),
              tooltip: context.t.download,
              onPressed: () => unawaited(downloadAssetVersion(context, ref, assetId, version)),
            ),
        ],
      ),
      body: InteractiveViewer(
        maxScale: 8,
        child: Center(
          child: Image(
            image: RemoteImageProvider(
              url: assetVersionImageUrl(assetId, version, size: AssetVersionImageSize.preview),
            ),
            fit: BoxFit.contain,
            frameBuilder: (context, child, frame, wasSynchronouslyLoaded) =>
                frame == null && !wasSynchronouslyLoaded ? const CircularProgressIndicator(color: Colors.white) : child,
            errorBuilder: (_, _, _) => const Icon(Icons.broken_image_outlined, color: Colors.white54, size: 48),
          ),
        ),
      ),
    );
  }
}
