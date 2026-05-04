export * from './core';
export * from './runtime';

// plan-review scopes
export { annotationToolbarShortcuts, useAnnotationToolbarShortcuts } from './plan-review/annotationToolbar.shortcuts';
export { commentPopoverShortcuts } from './plan-review/commentPopover.shortcuts';
export { imageAnnotatorShortcuts, useImageAnnotatorShortcuts } from './plan-review/imageAnnotator.shortcuts';
export { inputMethodShortcuts } from './plan-review/inputMethod.shortcuts';
export { viewerShortcuts, useViewerShortcuts } from './plan-review/viewer.shortcuts';

// code-review scopes
export { reviewAnnotationToolbarShortcuts, useReviewAnnotationToolbarShortcuts } from './code-review/annotationToolbar.shortcuts';
export { reviewFileTreeShortcuts, useReviewFileTreeShortcuts } from './code-review/fileTree.shortcuts';
export { reviewPrCommentsShortcuts, useReviewPrCommentsShortcuts } from './code-review/prComments.shortcuts';
