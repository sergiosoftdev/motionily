import { Controller, Get, Param, Query } from "@nestjs/common";
import { Public } from "../auth/auth";
import { BricksService } from "./bricks.service";
import { ListBricksQuery } from "./bricks.dto";
import { brickKey } from "./seed/catalog";
import { BrickSlot } from "./brick.enums";

/** The public brick store: official bricks only. Project-private bricks live under /projects/:id/bricks. */
@Public()
@Controller("bricks")
export class BricksController {
  constructor(private readonly bricks: BricksService) {}

  @Get()
  list(@Query() q: ListBricksQuery) {
    return this.bricks.list(q);
  }

  @Get(":slot/:id")
  get(@Param("slot") slot: BrickSlot, @Param("id") id: string) {
    return this.bricks.get(brickKey(slot, id));
  }
}
