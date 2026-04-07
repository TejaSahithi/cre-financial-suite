import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DoorOpen, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UnitService } from "@/services/api";
import { toast } from "sonner";

export default function CreateUnitModal({ isOpen, onClose, buildings = [] }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    unit_id_code: "",
    building_id: buildings[0]?.id || "",
    floor: "1",
    square_feet: "",
    unit_type: "office",
    occupancy_status: "vacant",
  });

  const createMutation = useMutation({
    mutationFn: (data) => UnitService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bu-units"] });
      toast.success("Unit created successfully.");
      onClose();
      setForm({ unit_id_code: "", building_id: buildings[0]?.id || "", floor: "1", square_feet: "", unit_type: "office", occupancy_status: "vacant" });
    },
    onError: (err) => {
      toast.error(`Failed to create unit: ${err.message}`);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.unit_id_code || !form.building_id) return;
    createMutation.mutate({
      ...form,
      square_feet: parseInt(form.square_feet) || 0,
      floor: parseInt(form.floor) || 1,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if(!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DoorOpen className="w-5 h-5 text-blue-600" />
            Add New Unit
          </DialogTitle>
          <DialogDescription>
            Specify details for a new unit or suite within a building.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="unit_id_code">Unit / Suite Number *</Label>
            <Input 
              id="unit_id_code" 
              placeholder="e.g. Suite 101" 
              value={form.unit_id_code} 
              onChange={e => setForm({...form, unit_id_code: e.target.value})} 
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="building">Building *</Label>
            <Select 
              value={form.building_id} 
              onValueChange={v => setForm({...form, building_id: v})}
            >
              <SelectTrigger id="building">
                <SelectValue placeholder="Select building..." />
              </SelectTrigger>
              <SelectContent>
                {buildings.map(b => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="floor">Floor</Label>
              <Input 
                id="floor" 
                type="number" 
                min="1" 
                value={form.floor} 
                onChange={e => setForm({...form, floor: e.target.value})} 
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="square_feet">Square Footage</Label>
              <Input 
                id="square_feet" 
                type="number" 
                placeholder="0" 
                value={form.square_feet} 
                onChange={e => setForm({...form, square_feet: e.target.value})} 
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="unit_type">Unit Type</Label>
              <Select 
                value={form.unit_type} 
                onValueChange={v => setForm({...form, unit_type: v})}
              >
                <SelectTrigger id="unit_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">Office</SelectItem>
                  <SelectItem value="retail">Retail</SelectItem>
                  <SelectItem value="industrial">Industrial</SelectItem>
                  <SelectItem value="amenity">Amenity</SelectItem>
                  <SelectItem value="storage">Storage</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">Occupancy Status</Label>
              <Select 
                value={form.occupancy_status} 
                onValueChange={v => setForm({...form, occupancy_status: v})}
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vacant">Vacant</SelectItem>
                  <SelectItem value="leased">Leased</SelectItem>
                  <SelectItem value="occupied">Occupied (Internal)</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-4 flex !justify-between items-center sm:!justify-between">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button 
              type="submit" 
              className="bg-blue-600 hover:bg-blue-700 min-w-[120px]" 
              disabled={!form.unit_id_code || !form.building_id || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create Unit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
