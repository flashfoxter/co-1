import { ByteStr, asciiByteStr } from '../bytestr'
import { Num } from '../num'
import { Pos, NoPos } from '../pos'
import { debuglog as dlog } from '../util'
import { Op, ops } from './op'
import {
  BasicType,
  NumType,
  FunType,

  t_nil,
  t_bool,
  t_u8,
  t_i8,
  t_u16,
  t_i16,
  t_u32,
  t_i32,
  t_u64,
  t_i64,
  t_f32,
  t_f64,
} from '../types'
import { postorder } from './postorder'
// import { LoopNest, loopnestFun } from './loopnest'


const byteStr_main = asciiByteStr("main")
const byteStr_anonfun = asciiByteStr("anonfun")


export type ID = int


// Aux is an auxiliary value of Value
//
export type Aux = ByteStr | Uint8Array | Num


// Value is a three-address-code operation
//
export class Value {
  id      :ID    // unique identifier
  pos     :Pos = NoPos  // source position
  op      :Op    // operation that computes this value
  type    :BasicType
  b       :Block // containing block
  aux     :Aux|null // auxiliary info for this value. Type depends on op & type
  args    :Value[]|null = null // arguments of this value
  comment :string = '' // human readable short comment for IR formatting
  prevv   :Value|null = null // previous value (list link)
  nextv   :Value|null = null // next value (list link)

  uses  :int = 0  // use count. Each appearance in args or b.control counts once
  users :Value[] = []

  constructor(id :ID, b :Block, op :Op, type :BasicType, aux :Aux|null) {
    this.id = id
    this.op = op
    this.type = type
    this.b = b
    this.aux = aux
    assert(type instanceof BasicType)
    assert(type.mem > 0, `ir.Value assigned abstract type ${type}`)
  }

  toString() {
    return 'v' + this.id
  }

  appendArg(v :Value) {
    // Note: Only used for Phi values. Assertion here to make sure we are
    // intenational about use.
    assert(this.op === ops.Phi, "appendArg on non-phi value")
    assert(v !== this, `using self as arg to self`)
    if (!this.args) {
      this.args = [v]
    } else {
      this.args.push(v)
    }
    v.uses++
    v.users.push(this)
  }

  // // replaceBy replaces all uses of this value with v
  // //
  // replaceBy(v :Value) {
  //   assert(v !== this, 'trying to replace V with V')

  //   for (let user of this.users) {
  //     assert(user !== v,
  //       `TODO user==v (v=${v} this=${this}) -- CYCLIC USE!`)

  //     if (user.args) for (let i = 0; i < user.args.length; i++) {
  //       if (user.args[i] === this) {
  //         dlog(`replace ${this} in user ${user} with ${v}`)
  //         user.args[i] = v
  //         v.users.push(user)
  //         v.uses++
  //         this.uses--
  //       }
  //     }
  //   }

  //   // Remove self.
  //   // Note that we don't decrement this.uses since the definition
  //   // site doesn't count toward "uses".
  //   this.b.removeValue(this)

  //   // Note: "uses" does not count for the value's ref to its block, so
  //   // we don't decrement this.uses here.
  //   if (DEBUG) { ;(this as any).b = null }
  // }

  // rematerializeable reports whether a register allocator should recompute
  // a value instead of spilling/restoring it.
  rematerializeable() :bool {
    if (!this.op.rematerializeable) {
      return false
    }
    if (this.args) for (let a of this.args) {
      // SP and SB (generated by ops.SP and ops.SB) are always available.
      if (a.op !== ops.SP && a.op !== ops.SB) {
        return false
      }
    }
    return true
  }
}


// BlockKind denotes what specific kind a block is
//
//     kind       control (x)    successors     notes
//     ---------- -------------- -------------- --------
//     Plain      (nil)          [next]         e.g. "goto"
//     If         boolean        [then, else]
//     Ret        memory         []
//
export enum BlockKind {
  Invalid = 0,
  Plain,
  If,
  Ret,
}

export enum BranchPrediction {
  Unlikely = -1,
  Unknown  = 0,
  Likely   = 1,
}

// Block represents a basic block
//
export class Block {
  id       :ID
  pos      :Pos = NoPos  // source position
  kind     :BlockKind = BlockKind.Invalid // The kind of block
  succs    :Block[]|null = null  // Successor/subsequent blocks (CFG)
  preds    :Block[]|null = null  // Predecessors (CFG)
  control  :Value|null = null
    // A value that determines how the block is exited. Its value depends
    // on the kind of the block. For instance, a BlockKind.If has a boolean
    // control value and BlockKind.Exit has a memory control value.

  f        :Fun // containing function

  // three-address code values
  vhead    :Value|null = null  // first value (linked list)
  vtail    :Value|null = null  // last value (linked list)
  valcount :int = 0  // number of values in list

  sealed   :bool = false
    // true if no further predecessors will be added
  comment  :string = '' // human readable short comment for IR formatting

  // Likely direction for branches.
  // If BranchLikely, succs[0] is the most likely branch taken.
  // If BranchUnlikely, succs[1] is the most likely branch taken.
  // Ignored if succs.length < 2.
  // Fatal if not BranchUnknown and succs.length > 2.
  likely :BranchPrediction = BranchPrediction.Unknown

  constructor(kind :BlockKind, id :ID, f :Fun) {
    this.kind = kind
    this.id = id
    this.f = f
  }

  // pushValue adds v to the end of the block
  //
  pushValue(v :Value) {
    if (this.vtail) {
      this.vtail.nextv = v
      v.prevv = this.vtail
    } else {
      this.vhead = v
    }
    this.vtail = v
    this.valcount++
  }

  // pushValueFront adds v to the top of the block
  //
  pushValueFront(v :Value) {
    if (this.vhead) {
      this.vhead.prevv = v
      v.nextv = this.vhead
    } else {
      this.vtail = v
    }
    this.vhead = v
    this.valcount++
  }

  // insertValueBefore inserts newval before refval.
  // Returns newvval
  //
  insertValueBefore(refval :Value, newval :Value) :Value {
    assert(refval.b === this)
    assert(newval.b === this)
    newval.prevv = refval.prevv
    newval.nextv = refval
    refval.prevv = newval
    if (newval.prevv) {
      newval.prevv.nextv = newval
    } else {
      this.vhead = newval
    }
    this.valcount++
    return newval
  }

  // removeValue removes v from this block.
  // returns the previous sibling, if any.
  //
  removeValue(v :Value) :Value|null {
    dlog(`${this} ${v}`)
    
    let prevv = v.prevv
    let nextv = v.nextv
    if (prevv) {
      prevv.nextv = nextv
    } else {
      this.vhead = nextv
    }
    if (nextv) {
      nextv.prevv = prevv
    } else {
      this.vtail = prevv
    }

    v.prevv = null
    v.nextv = null

    this.valcount--

    return prevv
  }

  // replaceValue replaces all uses of existingv value with newv
  //
  replaceValue(existingv :Value, newv :Value) {
    assert(existingv !== newv, 'trying to replace V with V')

    for (let user of existingv.users) {
      assert(user !== newv,
        `TODO user==newv (newv=${newv} existingv=${existingv}) -- CYCLIC USE!`)

      if (user.args) for (let i = 0; i < user.args.length; i++) {
        if (user.args[i] === existingv) {
          dlog(`replace ${existingv} in user ${user} with ${newv}`)
          user.args[i] = newv
          newv.users.push(user)
          newv.uses++
          existingv.uses--
        }
      }
    }

    // Remove self.
    // Note that we don't decrement this.uses since the definition
    // site doesn't count toward "uses".
    this.removeValue(existingv)

    // clear block pointer.
    // Note: "uses" does not count for the value's ref to its block, so
    // we don't decrement this.uses here.
    ;(existingv as any).b = null
  }

  newPhi(t :BasicType) :Value {
    let v = this.f.newValue(this, ops.Phi, t, null)
    this.pushValue(v)
    return v
  }

  // newValue0 return a value with no args
  newValue0(op :Op, t :BasicType|null = null, aux :Aux|null = null) :Value {
    let v = this.f.newValue(this, op, t, aux)
    this.pushValue(v)
    return v
  }

  // newValue1 returns a new value in the block with one argument
  newValue1(op :Op, t :BasicType, arg0 :Value, aux :Aux|null = null) :Value {
    let v = this.f.newValue(this, op, t, aux)
    v.args = [arg0]
    arg0.uses++ ; arg0.users.push(v)
    this.pushValue(v)
    return v
  }

  // newValue2 returns a new value in the block with two arguments and zero
  // aux values.
  newValue2(
    op :Op,
    t :BasicType,
    arg0 :Value,
    arg1 :Value,
    aux :Aux|null = null,
  ) :Value {
    let v = this.f.newValue(this, op, t, aux)
    v.args = [arg0, arg1]
    arg0.uses++ ; arg0.users.push(v)
    arg1.uses++ ; arg1.users.push(v)
    this.pushValue(v)
    return v
  }

  toString() :string {
    return 'b' + this.id
  }
}


export class Fun {
  entry  :Block
  blocks :Block[]
  type   :FunType
  name   :ByteStr
  nargs  :int      // number of arguments

  bid    :ID = 0  // block ID allocator
  vid    :ID = 0  // value ID allocator

  consts :Map<Op,Map<Num,Value>> | null = null  // constants cache

  // Cached CFG data
  _cachedPostorder :Block[] | null = null
  // _cachedLoopnest  :LoopNest | null = null


  constructor(type :FunType, name :ByteStr|null, nargs :int) {
    this.entry = new Block(BlockKind.Plain, this.bid++, this)
    this.blocks = [this.entry]
    this.type = type
    this.name = name || byteStr_anonfun
    this.nargs = nargs
  }

  newBlock(k :BlockKind) :Block {
    assert(this.bid < 0xFFFFFFFF, "too many block IDs generated")
    let b = new Block(k, this.bid++, this)
    this.blocks.push(b)
    return b
  }

  newValue(b :Block, op :Op, t :BasicType|null, aux :Aux|null) :Value {
    assert(this.vid < 0xFFFFFFFF, "too many value IDs generated")
    // TODO we could use a free list and return values when they die

    assert(!t || !op.type || op.type.mem == 0 || t === op.type,
      `op ${op} with different concrete type (op.type=${op.type}, t=${t})`)

    return new Value(++this.vid, b, op, t || op.type || t_nil, aux)
  }

  // constVal returns a constant Value representing c for type t
  //
  constVal(t :NumType, c :Num) :Value {
    let f = this

    // Select operation based on type
    let op :Op = ops.Invalid
    switch (t) {
      case t_bool:            op = ops.ConstBool; break
      case t_u8:  case t_i8:  op = ops.ConstI8; break
      case t_u16: case t_i16: op = ops.ConstI16; break
      case t_u32: case t_i32: op = ops.ConstI32; break
      case t_u64: case t_i64: op = ops.ConstI64; break
      case t_f32:             op = ops.ConstF32; break
      case t_f64:             op = ops.ConstF64; break
      default:
        assert(false, `invalid constant type ${t}`)
        break
    }

    let vv :Value[]|undefined

    if (!f.consts) {
      f.consts = new Map<Op,Map<Num,Value>>()
    }

    let nvmap = f.consts.get(op)
    if (!nvmap) {
      nvmap = new Map<Num,Value>()
    }

    let v = nvmap.get(c)
    if (!v) {
      // create new const value in function's entry block
      v = f.blocks[0].newValue0(op, t, c)
      nvmap.set(c, v) // put into cache
    }

    return v as Value
  }

  // numBlocks returns an integer larger than the id of any Block in the Fun.
  //
  numBlocks() :int {
    return this.bid
  }

  // numValues returns an integer larger than the id of any Value of any Block
  // in the Fun.
  //
  numValues() :int {
    return this.vid
  }

  postorder() :Block[] {
    if (!this._cachedPostorder) {
      this._cachedPostorder = postorder(this)
    }
    return this._cachedPostorder
  }

  // loopnest() :LoopNest {
  //   if (!this._cachedLoopnest) {
  //     this._cachedLoopnest = loopnestFun(this)
  //   }
  //   return this._cachedLoopnest
  // }

  // invalidateCFG tells the function that its CFG has changed
  //
  invalidateCFG() {
    this._cachedPostorder = null
    // this._cachedLoopnest = null
  }

  toString() {
    return this.name.toString()
  }
}


// Pkg represents a package with functions and data
//
export class Pkg {
  // data :Uint8Array   // data  TODO wrap into some simple linear allocator
  funs = new Map<ByteStr,Fun>()   // functions mapped by name
  init :Fun|null = null // init functions (merged into one)

  // mainFun returns the main function of the package, if any
  //
  mainFun() :Fun|null {
    for (let fn of this.funs.values()) {
      if (byteStr_main.equals(fn.name)) {
        return fn
      }
    }
    return null
  }
}
