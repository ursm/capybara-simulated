// V8 inline APIs rusty_v8 does not bind, for node_handle.rs (build.rs compiles this against the v8 crate's headers).

#include "v8-embedder-heap.h"
#include "v8-isolate.h"
#include "v8-local-handle.h"
#include "v8-object.h"
#include "v8-traced-handle.h"

// Reset `self` to `other` as a DROPPABLE traced reference: a young, unmodified API object it holds may be dropped by a
// scavenge rather than kept alive by it — and is then reset by the roots handler below.
extern "C" void csim_traced_reset_droppable(v8::TracedReference<v8::Object>* self, v8::Isolate* isolate, const v8::Object* other) {
  auto local = *reinterpret_cast<const v8::Local<v8::Object>*>(&other);
  self->Reset(isolate, local, v8::TracedReference<v8::Object>::IsDroppable{});
}

// Clear `self` — which needs no isolate, as a roots handler has none to give.
extern "C" void csim_traced_clear(v8::TracedReference<v8::Object>* self) {
  self->Reset();
}

// What a dropped object's wrappable is told (node_handle.rs `csim_node_reset_root`).
extern "C" void csim_node_reset_root(void* wrappable);

namespace {

// What V8 asks when a scavenge drops a young, unmodified wrapper a droppable reference held: the embedder clears that
// reference, found through the object it wraps under `tag` (Blink's model).
class RootsHandler final : public v8::EmbedderRootsHandler {
 public:
  RootsHandler(v8::Isolate* isolate, uint16_t tag) : isolate_(isolate), tag_(tag) {}
  void ResetRoot(const v8::TracedReference<v8::Value>& handle) override {
    auto tag = static_cast<v8::CppHeapPointerTag>(tag_);
    void* wrappable = v8::Object::Unwrap(isolate_, handle.As<v8::Object>(), v8::CppHeapPointerTagRange(tag, tag));
    if (wrappable) csim_node_reset_root(wrappable);
  }

 private:
  v8::Isolate* isolate_;
  uint16_t tag_;
};

}  // namespace

// Install the handler for the wrappers filed under `tag` on `isolate` — once, as the isolate's node template is made.
// (It lives as long as the process: one small object an isolate.)
extern "C" void csim_install_roots_handler(v8::Isolate* isolate, uint16_t tag) {
  isolate->SetEmbedderRootsHandler(new RootsHandler(isolate, tag));
}
