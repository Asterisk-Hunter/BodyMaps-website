import { Enums as CoreEnums, type RenderingEngine, type Types } from "@cornerstonejs/core";
import { Enums, segmentation } from "@cornerstonejs/tools";

/** Attach the volume actor before publishing its labelmap representation.
 *
 * Cornerstone 4's representation registration is synchronous; its renderer adds
 * the actor asynchronously. Several render requests during a slow NIfTI load can
 * each see no actor and add another one. Those layers compound the fill alpha
 * (four 50% layers appear 94% opaque). Pre-attaching one actor closes that window.
 * The segmentation ID is also its cached volume ID in both BodyMaps viewers.
 */
export async function addVolumeLabelmap(
  engine: RenderingEngine,
  viewportId: string,
  segmentationId: string,
  colorLUT: Types.ColorLUT,
): Promise<void> {
  const viewport = engine.getViewport(viewportId) as Types.IVolumeViewport;
  const representationUID = `${segmentationId}-${Enums.SegmentationRepresentations.Labelmap}`;
  if (!viewport.getActors().some((entry) => entry.representationUID === representationUID)) {
    await viewport.addVolumes([{
      volumeId: segmentationId,
      actorUID: representationUID,
      representationUID,
      visibility: true,
      blendMode: CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND,
    }], false, true);
  }
  segmentation.addSegmentationRepresentations(viewportId, [{
    segmentationId,
    type: Enums.SegmentationRepresentations.Labelmap,
    config: { colorLUTOrIndex: colorLUT },
  }]);
}
