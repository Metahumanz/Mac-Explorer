#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static NSArray *captured = @[];
static NSUInteger calls = 0;
static NSDragOperation outsideMask = NSDragOperationNone;
static id BeginDrag(id self, SEL command, NSArray<NSDraggingItem *> *items, NSEvent *event, id<NSDraggingSource> source) {
  NSMutableArray *files = [NSMutableArray array];
  for (NSDraggingItem *item in items) {
    id<NSPasteboardWriting> writer = item.item;
    NSString *url = [writer pasteboardPropertyListForType:NSPasteboardTypeFileURL];
    [files addObject:@{ @"url": url ?: @"", @"width": @(item.draggingFrame.size.width), @"height": @(item.draggingFrame.size.height) }];
  }
  captured = files; calls++;
  outsideMask = [source draggingSession:(NSDraggingSession *)[NSObject new] sourceOperationMaskForDraggingContext:NSDraggingContextOutsideApplication];
  return nil; // Capture the real AppKit payload without dropping into another application.
}
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"items": captured, @"calls": @(calls), @"outsideMask": @(outsideMask) } options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  napi_value result; napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  method_setImplementation(class_getInstanceMethod([NSView class], @selector(beginDraggingSessionWithItems:event:source:)), (IMP)BeginDrag);
  napi_value snapshot;
  napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, Snapshot, nullptr, &snapshot);
  napi_set_named_property(env, exports, "snapshot", snapshot);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
