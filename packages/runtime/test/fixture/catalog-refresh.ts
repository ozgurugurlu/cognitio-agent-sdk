import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Provider, ModelsDev } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage"
import { Global } from "../../src/global"
import { Hash } from "@cognitio/shared/util/hash"
import path from "node:path"

await ModelsDev.refresh(true)
await Instance.provide({
  directory: process.argv[3],
  fn: async () => {
    const read = () =>
      AppRuntime.runPromise(
        Provider.Service.use((svc) => svc.getModel(ProviderID.make("openai"), ModelID.make("catalog-test"))),
      )
    const first = await read()
    await fetch(`${process.argv[2]}/advance`)
    await ModelsDev.refresh(true)
    const second = await read()
    const cache = path.join(Global.Path.cache, `models-${Hash.fast(process.argv[2])}.json`)
    const updated = await Bun.file(cache).json()
    updated.openai.models["catalog-test"].cost.input = 3
    await Bun.write(cache, JSON.stringify(updated))
    await ModelsDev.refresh()
    const third = await read()
    console.log(`catalog-costs:${first.cost.input},${second.cost.input},${third.cost.input}`)
  },
})
await Instance.disposeAll()
await AppRuntime.dispose()
Database.close()
