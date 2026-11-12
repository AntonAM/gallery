import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/datetime_extensions.dart';
import 'package:immich_mobile/extensions/duration_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/gallery/versions/asset_version_download.dart';
import 'package:immich_mobile/gallery/versions/asset_version_preview.page.dart';
import 'package:immich_mobile/gallery/versions/asset_versions.repository.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/sheet_tile.widget.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/utils/bytes_units.dart';
import 'package:immich_mobile/utils/timezone.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

final _log = Logger('AssetVersionsDetails');

/// The "Versions" section of the asset details sheet: the files of the photo's shot (its edits, the camera's own
/// file, the RAW), fetched when the sheet opens. They can be viewed and downloaded, not changed: Gallery arranges
/// versions itself. Shown only for a remote photo that has versions; while loading, on any error (an older server
/// answers 404) and when there are none, it takes no space.
class AssetVersionsDetails extends ConsumerWidget {
  const AssetVersionsDetails({super.key, required this.asset, this.exifInfo});

  final BaseAsset asset;

  /// The photo's own metadata: its time zone is the one the versions' capture times are shown in.
  final ExifInfo? exifInfo;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = this.asset;
    if (!asset.isImage || !asset.hasRemote) {
      return const SizedBox.shrink();
    }
    final assetId = switch (asset) {
      RemoteAsset(:final id) => id,
      LocalAsset(:final remoteAssetId) => remoteAssetId,
    };
    if (assetId == null) {
      return const SizedBox.shrink();
    }

    // a server without versions answers 404, which is no news; any other failure hides the section too, and is logged
    ref.listen(assetVersionsProvider(assetId), (_, next) {
      final error = next.error;
      if (error != null && !(error is ApiException && error.code == 404)) {
        _log.warning('Could not load the versions of $assetId', error, next.stackTrace);
      }
    });
    final state = ref.watch(assetVersionsProvider(assetId));
    final data = state.hasError ? null : state.valueOrNull;
    if (data == null || data.versions.isEmpty) {
      return const SizedBox.shrink();
    }

    // the photo's distance from UTC, as the date row of this sheet works it out
    final (_, cameraOffset) = resolveAssetDateTime(asset, exifInfo);

    return Padding(
      padding: const EdgeInsets.only(top: 16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SheetTile(
            title: context.t.asset_versions,
            titleStyle: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            trailing: Text(
              context.t.asset_versions_count(count: data.versions.length),
              style: context.textTheme.labelMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            ),
          ),
          const SizedBox(height: 4),
          for (final version in data.versions)
            AssetVersionTile(assetId: assetId, version: version, cameraOffset: cameraOffset),
        ],
      ),
    );
  }
}

/// One version: thumbnail, kind badge, file name, format, size and dimensions, its time with the time zone (an edit:
/// when it was made, on the phone's clock; any other file: when it was taken, on the camera's), and its download.
class AssetVersionTile extends ConsumerWidget {
  const AssetVersionTile({super.key, required this.assetId, required this.version, required this.cameraOffset});

  final String assetId;
  final AssetVersion version;

  /// The photo's distance from UTC: capture times are shown on the camera's clock.
  final Duration cameraOffset;

  static const double _thumbSize = 64;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final secondary = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceSecondary);
    final details = [
      _format(version),
      if (version.fileSizeInByte case final size?) formatBytes(size),
      if (version.width case final width?)
        if (version.height case final height?) '$width × $height',
    ].nonNulls.join(' · ');

    return InkWell(
      key: ValueKey('asset-version-${version.id}'),
      onTap: () => unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => AssetVersionPreviewPage(assetId: assetId, version: version),
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: const BorderRadius.all(Radius.circular(8)),
              child: Container(
                width: _thumbSize,
                height: _thumbSize,
                color: context.colorScheme.surfaceContainerHighest,
                child: Image(
                  image: RemoteImageProvider(url: assetVersionImageUrl(assetId, version)),
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => const Icon(Icons.image_not_supported_outlined),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 2,
                children: [
                  Row(
                    spacing: 6,
                    children: [
                      _KindBadge(kind: version.kind),
                      if (version.shown)
                        Text(
                          context.t.asset_versions_shown,
                          key: ValueKey('asset-version-shown-${version.id}'),
                          style: context.textTheme.labelSmall?.copyWith(
                            color: context.colorScheme.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      Flexible(
                        child: Text(
                          version.originalFileName,
                          style: context.textTheme.bodyMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  if (details.isNotEmpty) Text(details, style: secondary, maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text(_when(context), style: secondary, maxLines: 1, overflow: TextOverflow.ellipsis),
                  if (version.isOffline)
                    Row(
                      spacing: 4,
                      children: [
                        Icon(Icons.cloud_off_outlined, size: 14, color: context.colorScheme.error),
                        Text(
                          context.t.asset_versions_offline,
                          style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.error),
                        ),
                      ],
                    ),
                ],
              ),
            ),
            // an offline file cannot be sent by the server
            if (!version.isOffline)
              IconButton(
                key: ValueKey('asset-version-download-${version.id}'),
                icon: const Icon(Icons.download_outlined),
                tooltip: context.t.download,
                onPressed: () => unawaited(downloadAssetVersion(context, ref, assetId, version)),
              ),
          ],
        ),
      ),
    );
  }

  /// The file's format, from its extension ("DNG", "JPG"), else the MIME subtype.
  static String? _format(AssetVersion version) {
    final name = version.originalFileName;
    final dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
      return name.substring(dot + 1).toUpperCase();
    }
    final mime = version.originalMimeType;
    final slash = mime?.indexOf('/') ?? -1;
    return mime != null && slash >= 0 ? mime.substring(slash + 1).toUpperCase() : null;
  }

  /// The file's time with its time zone, as the date row of the sheet writes the photo's.
  String _when(BuildContext context) {
    final locale = resolvedDateTimeLocale();
    final format = MediaQuery.alwaysUse24HourFormatOf(context)
        ? DateFormat.yMMMd(locale).add_Hm()
        : DateFormat.yMMMd(locale).add_jm();
    final (time, offset) = version.listed(cameraOffset);
    return '${format.format(time)} GMT${offset.formatAsOffset()}';
  }
}

class _KindBadge extends StatelessWidget {
  const _KindBadge({required this.kind});

  final AssetVersionKind kind;

  @override
  Widget build(BuildContext context) {
    final colors = context.colorScheme;
    final (label, background, foreground) = switch (kind) {
      AssetVersionKind.raw => (context.t.asset_versions_kind_raw, colors.tertiaryContainer, colors.onTertiaryContainer),
      AssetVersionKind.original => (
        context.t.asset_versions_kind_original,
        colors.surfaceContainerHighest,
        colors.onSurface,
      ),
      _ => (context.t.asset_versions_kind_edit, colors.secondaryContainer, colors.onSecondaryContainer),
    };
    return DecoratedBox(
      decoration: BoxDecoration(color: background, borderRadius: const BorderRadius.all(Radius.circular(4))),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        child: Text(
          label,
          style: context.textTheme.labelSmall?.copyWith(color: foreground, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}
