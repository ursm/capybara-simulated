// V8 APIs rusty_v8 does not bind, for node_handle.rs, script.rs and legacy.rs (build.rs compiles this against the v8
// crate's headers).

#include "v8-embedder-heap.h"
#include "v8-function.h"
#include "v8-isolate.h"
#include "v8-local-handle.h"
#include "v8-object.h"
#include "v8-proxy.h"
#include "v8-template.h"
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

// The function `f` calls: a bound function's target, a callable proxy's, through every bind and proxy
// (Function::GetBoundFunction, Proxy::GetTarget), or `f` itself — a handle of the current scope. (Its `Local` an indirect
// one, a slot's address, as V8 is built without V8_ENABLE_DIRECT_HANDLE — as `csim_traced_reset_droppable`'s.)
extern "C" const v8::Function* csim_bound_target(const v8::Function* f) {
  v8::Local<v8::Value> fn = *reinterpret_cast<const v8::Local<v8::Function>*>(&f);
  for (;;) {
    v8::Local<v8::Value> target = fn->IsProxy() ? fn.As<v8::Proxy>()->GetTarget() : fn.As<v8::Function>()->GetBoundFunction();
    if (!target->IsFunction()) break;
    fn = target;
  }
  return *fn.As<v8::Function>();
}

// …an object of the template `t` HTML's [[IsHTMLDDA]] one (V8's undetectable: typeof "undefined", falsy, == null) and
// callable, a call of it the function its internal field `ALL_CALL_FIELD` holds, of its first argument — the one
// HTMLAllCollection's [[Call]] reads — and of no receiver (legacy.rs `allCollectionObject`: the object called is the
// callback's `This`).
namespace {
constexpr int ALL_CALL_FIELD = 4;
void call_field(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Data> field = info.This()->GetInternalField(ALL_CALL_FIELD);
  if (!field->IsValue() || !field.As<v8::Value>()->IsFunction()) return;
  v8::Local<v8::Value> argv[1] = {info[0]};
  v8::Local<v8::Value> result;
  if (field.As<v8::Function>()->Call(isolate->GetCurrentContext(), v8::Undefined(isolate), info.Length() > 0 ? 1 : 0, argv).ToLocal(&result)) {
    info.GetReturnValue().Set(result);
  }
}
}  // namespace
extern "C" void csim_template_undetectable_callable(v8::ObjectTemplate* t) {
  auto tpl = *reinterpret_cast<v8::Local<v8::ObjectTemplate>*>(&t);
  tpl->MarkAsUndetectable();
  tpl->SetCallAsFunctionHandler(call_field);
}

// What a dropped object's wrappable is told (node_handle.rs `csim_node_reset_root`).
extern "C" void csim_node_reset_root(void* wrappable);

namespace {

// What V8 asks when a scavenge drops a young, unmodified wrapper a droppable reference held: the embedder clears that
// reference, found through the object it wraps under `tag` (Blink's model). It MUST be cleared: one left set is zapped
// by V8 and crashes the next scavenge — so only a wrapper filed under `tag` may ever be held by a droppable reference.
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
